/**
 * runtime の分類。
 *
 * 同じ 3 値の列挙が制御・起動・監視の各所へ散っていたため、 意味のある単位へ寄せる。
 * runtime を増やすときに触るのはこのファイルだけで済ませる。
 */

import type { Service } from './loader.js';

type Runtime = Service['runtime'];

/**
 * Excubitor 自身が spawn してプロセスとして面倒を見る runtime。
 * 制御・autostart・再採用・メモリ監視の対象判定はすべてこれを使う。
 */
const LOCAL_PROCESS_RUNTIMES = new Set<string>(['node', 'python', 'dev-process-md', 'app']);

/**
 * cwd + command を解決してそのまま spawn する runtime。
 * `command` の先頭トークンを実行ファイルとして起動するため、 node 以外の処理系でも同じ経路に乗る。
 */
const COMMAND_RUNTIMES = new Set<string>(['node', 'python']);

/** コンテナとして scanner が実体を同期する runtime。 */
const DOCKER_RUNTIMES = new Set<string>(['docker', 'docker-compose']);

export function isLocalProcessRuntime(runtime: string): boolean {
  return LOCAL_PROCESS_RUNTIMES.has(runtime);
}

export function isCommandRuntime(runtime: string): boolean {
  return COMMAND_RUNTIMES.has(runtime);
}

export function isDockerRuntime(runtime: string): boolean {
  return DOCKER_RUNTIMES.has(runtime);
}

/**
 * `cwd` (または `start_script`) を起点にコマンドを解決する runtime。
 * app は `exec` を絶対パスで持つのでここには入らない。
 */
export function needsWorkingDirectory(runtime: string): boolean {
  return isLocalProcessRuntime(runtime) && runtime !== 'app';
}

export type { Runtime };
