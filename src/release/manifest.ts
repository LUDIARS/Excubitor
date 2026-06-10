/**
 * リリースマニフェスト (`releases/<name>.yaml`) の型・スキーマ・ローダ。
 *
 * 1 マニフェスト = 1 つの「自己完結ランナブル配布物」の宣言。
 * primary (= 起動エントリのアプリ) と、 同梱する関連 component (lib / cli) を列挙し、
 * 各 component の repo / build 手順 / バンドルへ取り込むパスを定義する。
 *
 * 実ビルドは持たない (純粋に宣言を読むだけ)。 ビルドは orchestrator が行う。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';

/**
 * component の役割:
 * - primary : 起動エントリのアプリ。 バンドルの `app/` に置く (1 つだけ)。
 * - lib     : primary が import するライブラリ。 `packages/<code>/` に置く。
 * - cli     : 実行ファイルを持つツール。 `packages/<code>/` に置き、 launcher が
 *             bundle 直下 `bin/` に shim を生成して PATH に載せる (例: lictor / famulus)。
 * - optional: 同梱するが既定では使わない補助 component (扱いは lib と同じ)。
 */
export const ComponentRoleSchema = z.enum(['primary', 'lib', 'cli', 'optional']);

const ComponentSchema = z.object({
  /** 論理 id。 path 省略時は catalog の同 code サービスから repo を解決する。 */
  code: z.string(),
  role: ComponentRoleSchema,
  /** repo ディレクトリ (絶対パス推奨)。 省略時は catalog から解決。 */
  path: z.string().optional(),
  /** repo 内で順に実行するビルド手順 (例: ["npm ci", "npm run build"])。 */
  build: z.array(z.string()).default([]),
  /** repo からの相対パスで、 バンドルの component dir へコピーする対象。 */
  include: z.array(z.string()).default(['dist', 'package.json', 'package-lock.json']),
  /** バンドル内 component dir で `npm ci --omit=dev` を実行し prod node_modules を生成する。 */
  prod_install: z.boolean().default(true),
  /** role=cli: PATH に出す shim のコマンド名 (例: "lictor")。 */
  bin_name: z.string().optional(),
  /** role=cli: component dir からの相対の実行スクリプト (例: "bin/lictor.mjs")。 */
  bin_entry: z.string().optional(),
});

const RuntimeSchema = z
  .object({
    /** true で Node ランタイム本体をバンドルに同梱する (host に Node を要求しない)。 */
    bundle: z.boolean().default(false),
    /** bundle=true のとき同梱する node 実行ファイルの絶対パス。 省略なら同梱しない。 */
    node_path: z.string().optional(),
  })
  .default({ bundle: false });

export const ReleaseManifestSchema = z.object({
  /** バンドル名 (出力フォルダ名の素。 例: "discutere-allinone")。 */
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  /** primary component の code (role=primary の component に存在する必要がある)。 */
  primary: z.string(),
  components: z.array(ComponentSchema).min(1),
  /** ビルド成果物の出力ベース dir (default dist/releases)。 */
  output_dir: z.string().default('dist/releases'),
  /** launcher が app/ で叩く起動コマンド。 */
  start_command: z
    .object({
      cmd: z.string().default('node'),
      args: z.array(z.string()).default(['dist/index.js']),
    })
    .default({ cmd: 'node', args: ['dist/index.js'] }),
  runtime: RuntimeSchema,
  /** README.txt に出す補足行。 */
  readme_notes: z.array(z.string()).default([]),
});

export type Component = z.infer<typeof ComponentSchema>;
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** 生オブジェクトを検証して ReleaseManifest にする。 不整合は throw。 */
export function parseReleaseManifest(raw: unknown): ReleaseManifest {
  const m = ReleaseManifestSchema.parse(raw);
  const primary = m.components.filter((c) => c.role === 'primary');
  if (primary.length !== 1) {
    throw new Error(`manifest "${m.name}": role=primary の component はちょうど 1 つ必要 (現在 ${primary.length})`);
  }
  if (primary[0]!.code !== m.primary) {
    throw new Error(`manifest "${m.name}": primary "${m.primary}" が role=primary component (${primary[0]!.code}) と一致しない`);
  }
  for (const c of m.components) {
    if (c.role === 'cli' && (!c.bin_name || !c.bin_entry)) {
      throw new Error(`component "${c.code}": role=cli には bin_name と bin_entry が必要`);
    }
  }
  return m;
}

/** YAML ファイルからマニフェストを読む。 */
export function loadReleaseManifest(path: string): ReleaseManifest {
  const abs = resolve(process.cwd(), path);
  return parseReleaseManifest(load(readFileSync(abs, 'utf8')));
}

/** `releases/` 配下の *.yaml を列挙する (name = 拡張子なしのファイル名)。 */
export function listReleaseManifests(dir = 'releases'): { name: string; path: string }[] {
  const abs = resolve(process.cwd(), dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => ({ name: basename(f).replace(/\.ya?ml$/, ''), path: join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
