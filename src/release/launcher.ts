/**
 * バンドルの launcher・shim・README・VERSION.json を文字列として組み立てる純関数群。
 *
 * 自己完結ランナブル配布物のレイアウト:
 *   <bundle>/
 *     start.bat / start.sh        ← PATH に bin/ を載せて app/ で起動コマンドを叩く
 *     bin/<name>.cmd / <name>     ← role=cli component を PATH に出す shim
 *     app/                        ← primary (起動エントリ)
 *     packages/<code>/            ← lib / cli component
 *     runtime/node(.exe)          ← runtime.bundle 時のみ
 *     VERSION.json / README.txt
 */

export interface CliBin {
  /** PATH 上のコマンド名 (例: "lictor")。 */
  name: string;
  /** バンドル内の配置先 (例: "packages/lictor")。 */
  subdir: string;
  /** subdir からの相対の実行スクリプト (例: "bin/lictor.mjs")。 */
  entry: string;
}

export interface LauncherOptions {
  name: string;
  displayName: string;
  version: string;
  /** app/ で叩く起動コマンド。 */
  startCmd: string;
  startArgs: string[];
  cliBins: CliBin[];
  /** runtime.bundle で同梱した node を使うか (true なら相対 runtime/node を呼ぶ)。 */
  bundledNode: boolean;
  readmeNotes: string[];
}

/** 同梱 node か host の起動コマンドか。 .bat 用 (%ROOT% 相対)。 */
function nodeRefBat(o: LauncherOptions): string {
  return o.bundledNode ? '"%ROOT%runtime\\node.exe"' : o.startCmd;
}

/** 同梱 node か host の起動コマンドか。 .sh 用 ($ROOT 相対)。 */
function nodeRefSh(o: LauncherOptions): string {
  return o.bundledNode ? '"$ROOT/runtime/node"' : o.startCmd;
}

export function renderStartBat(o: LauncherOptions): string {
  const node = nodeRefBat(o);
  const args = o.startArgs.map((a) => a.replace(/\//g, '\\')).join(' ');
  return [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'set "PATH=%ROOT%bin;%PATH%"',
    'pushd "%ROOT%app"',
    `${node} ${args} %*`,
    'set "EXITCODE=%ERRORLEVEL%"',
    'popd',
    'exit /b %EXITCODE%',
    '',
  ].join('\r\n');
}

export function renderStartSh(o: LauncherOptions): string {
  const node = nodeRefSh(o);
  const args = o.startArgs.join(' ');
  return [
    '#!/usr/bin/env sh',
    'set -e',
    'ROOT="$(cd "$(dirname "$0")" && pwd)"',
    'export PATH="$ROOT/bin:$PATH"',
    'cd "$ROOT/app"',
    `exec ${node} ${args} "$@"`,
    '',
  ].join('\n');
}

/** bin/<name>.cmd — bundle 直下の bin から packages/<code>/<entry> を node で起動。 */
export function renderCliShimBat(bin: CliBin, bundledNode: boolean): string {
  const node = bundledNode ? '"%~dp0..\\runtime\\node.exe"' : 'node';
  const entry = `%~dp0..\\${bin.subdir}\\${bin.entry}`.replace(/\//g, '\\');
  return ['@echo off', `${node} "${entry}" %*`, ''].join('\r\n');
}

/** bin/<name> — POSIX shim。 */
export function renderCliShimSh(bin: CliBin, bundledNode: boolean): string {
  const node = bundledNode ? '"$DIR/../runtime/node"' : 'node';
  return [
    '#!/usr/bin/env sh',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    `exec ${node} "$DIR/../${bin.subdir}/${bin.entry}" "$@"`,
    '',
  ].join('\n');
}

export interface VersionComponent {
  code: string;
  role: string;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export interface VersionInfo {
  name: string;
  version: string;
  built_at: string;
  components: VersionComponent[];
}

export function buildVersionInfo(
  name: string,
  version: string,
  builtAt: string,
  components: VersionComponent[],
): VersionInfo {
  return { name, version, built_at: builtAt, components };
}

export function renderReadme(o: LauncherOptions): string {
  const lines: string[] = [];
  lines.push(`${o.displayName} (${o.name}) v${o.version}`);
  lines.push('='.repeat(48));
  lines.push('');
  lines.push('自己完結ランナブル配布物 (LUDIARS Excubitor release)。');
  lines.push('');
  lines.push('# 起動');
  lines.push('  Windows : start.bat をダブルクリック (または cmd で実行)');
  lines.push('  macOS/Linux : ./start.sh');
  lines.push('');
  if (!o.bundledNode) {
    lines.push('# 前提');
    lines.push('  Node.js 22+ が PATH にあること (ランタイムは同梱していない)。');
    lines.push('');
  }
  if (o.cliBins.length > 0) {
    lines.push('# 同梱ツール (起動時に PATH へ追加される)');
    for (const b of o.cliBins) lines.push(`  - ${b.name}  (${b.subdir})`);
    lines.push('');
  }
  if (o.readmeNotes.length > 0) {
    lines.push('# セットアップ');
    for (const n of o.readmeNotes) lines.push(`  ${n}`);
    lines.push('');
  }
  lines.push('# 構成');
  lines.push('  app/        : 起動エントリ (primary)');
  lines.push('  packages/   : 同梱 lib / cli');
  lines.push('  bin/        : 同梱 cli の PATH shim');
  lines.push('  VERSION.json: ビルド時の各 component の commit');
  lines.push('');
  return lines.join('\n');
}
