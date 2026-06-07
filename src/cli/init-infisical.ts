/**
 * Infisical 初期化 CLI (env-cli の setup 相当)。
 *
 * Excubitor が secret を解決するのに必要な「初期値」を対話入力で
 * 暗号化 config-store に保存するだけのもの:
 *   1. machine identity (siteUrl / environment / clientId / clientSecret)
 *   2. (任意) サービスごとの Infisical マッピング (project_id 等)
 *
 * env もファイルも生成しない。 値は config-store (AppData, AES-256-GCM) に入る。
 *
 *   npm run init-infisical
 */

import {
  saveInfisicalIdentity,
  getInfisicalIdentity,
  getIdentityStatus,
  getServiceMap,
  setServiceMap,
  applyInfisicalToEnv,
  type ServiceInfisical,
} from '../secrets/config-store.js';
import { readIdentity, verifyIdentity } from '../secrets/infisical.js';
import { createPrompt, type Prompt } from '../secrets/prompt.js';

const DEFAULT_SITE_URL = 'https://app.infisical.com';
const DEFAULT_ENVIRONMENT = 'dev';

async function setupIdentity(p: Prompt): Promise<void> {
  const status = getIdentityStatus();
  console.log('\n── Excubitor machine identity ──');
  console.log(`  保存先: ${status.storePath}`);
  if (status.configured) {
    console.log(
      `  現在: siteUrl=${status.siteUrl} environment=${status.environment} clientId=${status.clientIdHint}`,
    );
    console.log('  (空 Enter で既存値を維持)');
  }

  const siteUrl = await p.ask('Infisical site URL', status.siteUrl ?? DEFAULT_SITE_URL);
  const environment = await p.ask('Environment', status.environment ?? DEFAULT_ENVIRONMENT);
  const clientId = await p.ask('Universal Auth Client ID', status.configured ? '(既存を維持)' : undefined);
  const clientSecret = await p.askSecret('Universal Auth Client Secret (空=既存維持)');

  // 「既存を維持」が選ばれた場合は現在値を読んで埋める。
  const current = status.configured ? readCurrentIdentity() : null;
  const resolvedClientId = clientId === '(既存を維持)' ? (current?.clientId ?? '') : clientId;
  const resolvedClientSecret = clientSecret.length > 0 ? clientSecret : (current?.clientSecret ?? '');

  if (!resolvedClientId || !resolvedClientSecret) {
    throw new Error('Client ID / Secret は必須です (初回は両方入力してください)');
  }

  saveInfisicalIdentity({
    siteUrl,
    environment,
    clientId: resolvedClientId,
    clientSecret: resolvedClientSecret,
  });
  console.log('  ✓ identity を暗号化保存しました');

  // 接続確認 (任意・失敗しても保存は維持)。
  const doTest = (await p.ask('Infisical へ接続テストしますか? (y/N)', 'N')).toLowerCase();
  if (doTest === 'y' || doTest === 'yes') {
    applyInfisicalToEnv();
    const id = readIdentity();
    if (!id) {
      console.log('  ! identity を env に展開できませんでした (skip)');
      return;
    }
    try {
      await verifyIdentity(id);
      console.log('  ✓ 接続成功 (login OK)');
    } catch (err) {
      console.log(`  ✗ 接続失敗: ${(err as Error).message} (保存は維持されています)`);
    }
  }
}

/** config-store から現在の identity を読む (clientSecret 含む、 既存値の充当のみに使う)。 */
function readCurrentIdentity(): { clientId: string; clientSecret: string } | null {
  const id = getInfisicalIdentity();
  return id ? { clientId: id.clientId, clientSecret: id.clientSecret } : null;
}

async function setupServiceMappings(p: Prompt): Promise<void> {
  console.log('\n── サービス Infisical マッピング (任意) ──');
  const map = getServiceMap();
  const existing = Object.keys(map);
  if (existing.length > 0) {
    console.log(`  現在登録済: ${existing.join(', ')}`);
  }

  for (;;) {
    const code = (await p.ask('追加するサービスコード (空 Enter で終了)')).trim();
    if (!code) break;

    const prev = map[code];
    const projectId = await p.ask('  Infisical project_id (workspaceId)', prev?.project_id);
    if (!projectId) {
      console.log('  ! project_id が空のためスキップ');
      continue;
    }
    const environment = await p.ask('  environment', prev?.environment ?? DEFAULT_ENVIRONMENT);
    const prefix = await p.ask('  prefix (任意、空可)', prev?.prefix ?? '');

    const entry: ServiceInfisical = {
      project_id: projectId,
      environment,
      inject: true,
      prefix,
    };
    if (prev?.include) entry.include = prev.include;
    if (prev?.exclude) entry.exclude = prev.exclude;
    map[code] = entry;
    console.log(`  ✓ ${code} を登録 (project_id=${projectId} env=${environment})`);
  }

  // getServiceMap() のコピーを編集してきたので全体を保存 (既存も維持される)。
  setServiceMap(map);
  console.log('  ✓ サービスマッピングを暗号化保存しました');
}

async function main(): Promise<void> {
  console.log('Excubitor Infisical 初期化 (setup)');
  const p = createPrompt();
  try {
    await setupIdentity(p);
    await setupServiceMappings(p);
    console.log('\n完了しました。');
  } finally {
    p.close();
  }
}

main().catch((err) => {
  console.error(`\n初期化を中止しました: ${(err as Error).message}`);
  process.exit(1);
});
