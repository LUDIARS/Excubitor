/**
 * 他拠点に公開する federation API。 すべて相互登録済みのピアからの署名付き要求だけを通す
 * (peer-auth.ts: 相手が本拠点の token を知っていて、 かつ本拠点が相手を登録している)。
 *
 *   GET  /api/v1/federation/health            担保サービス + キャッシュ済み死活 + つながり + 拠点情報 + 依頼の履歴
 *   GET  /api/v1/federation/node              サマリ + サービス一覧 + host メトリクス (旧形式)
 *   POST /api/v1/federation/operations        依頼 (更新 / 再起動 / デプロイ / 反映 / 起動 / 停止)
 *   GET  /api/v1/federation/operations/:id    依頼の状態
 *   POST /api/v1/federation/operations/reauthorize  依頼元として、相手の待ち行列で期限切れした依頼の実行 token を同じ範囲で再発行
 *   GET  /api/v1/federation/git/bundle        外部に出られない拠点への git bundle
 *   POST /api/v1/federation/vault/env         本社から拠点へ Vault の値 (担保サービス分だけ)
 *
 * このルーターだけが拠点間リスナー (listener.ts、 メッシュ側アドレス) に載る。 ピア管理や
 * 設定などの管理面は載せない。 loopback の本体 (17332) にも同じルーターを載せる。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { localNodeSnapshot } from './node-snapshot.js';
import type { NodeHealthPayload } from './health-types.js';
import { requireMutualPeer, type FederationEnv } from './peer-auth.js';
import type { FederationListenerStatus } from './listener.js';
import { buildOperationPublicRoutes } from './operations/public-routes.js';
import { buildBundleRoutes } from './operations/bundle-routes.js';
import { buildReauthorizeRoutes } from './operations/reauthorize-routes.js';
import { REAUTHORIZE_PATH } from './security/reauthorization.js';
import type { OperationRunner } from './operations/runner.js';
import { buildVaultPublicRoutes } from '../vault/vault-federation.js';
import { sharedVault } from '../vault/vault.js';
import { permitsMeshAction } from './security/grants.js';
import { bodyLimit } from 'hono/body-limit';

/** @implements SPEC-FEDERATION-MUTUAL-AUTH */

export interface FederationPublicDeps {
  getCatalog: () => Catalog;
  getListenerStatus: () => FederationListenerStatus;
  runner: OperationRunner;
  readHealth: () => NodeHealthPayload | null;
}

export function buildFederationPublicRouter(deps: FederationPublicDeps): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();
  // ルート単位で付ける: このルーターは本体 (17332) にも route() で載るので、
  // `/api/v1/federation/*` 全体に掛けると同じ prefix の管理面 (loopback 用) まで塞いでしまう。
  const auth = requireMutualPeer();
  app.use('/api/v1/federation/operations', bodyLimit({ maxSize: 64 * 1024 }));
  app.use('/api/v1/federation/vault/env', bodyLimit({ maxSize: 64 * 1024 }));
  app.use(REAUTHORIZE_PATH, bodyLimit({ maxSize: 4 * 1024 }));

  app.get('/api/v1/federation/health', auth, (c) => {
    const caller = c.get('federationCaller');
    if (!permitsMeshAction({ caller, action: 'monitor', resource: `node:${caller.audience}` })) return c.json({ error: 'forbidden' }, 403);
    const snapshot = deps.readHealth();
    return snapshot ? c.json(snapshot) : c.json({ error: 'snapshot_pending' }, 503);
  });

  app.get('/api/v1/federation/node', auth, (c) => {
    const caller = c.get('federationCaller');
    return permitsMeshAction({ caller, action: 'monitor', resource: `node:${caller.audience}` })
      ? c.json(localNodeSnapshot()) : c.json({ error: 'forbidden' }, 403);
  });

  // 静的 path の再認可を `/operations/:id` より先に載せる。
  app.route('/', buildReauthorizeRoutes({ auth }));
  app.route('/', buildOperationPublicRoutes({ getCatalog: deps.getCatalog, runner: deps.runner, auth }));
  app.route('/', buildBundleRoutes(deps.getCatalog, auth));
  app.route('/', buildVaultPublicRoutes({ auth, vault: sharedVault }));

  return app;
}
