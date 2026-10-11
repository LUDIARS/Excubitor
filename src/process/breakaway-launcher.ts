/**
 * job-breakaway spawn の短命 launcher (win32 専用)。
 * 正本: spec/plan/design.md §17 (win32 job-breakaway spawn)。
 *
 * WMI (Win32_Process.Create) は stdio のリダイレクトを持たない。以前はそれを
 * `cmd.exe /d /s /c "<command> 1>>out.log 2>>err.log"` で補っていたが、この cmd.exe は
 * **サービスの生存期間ずっと居座り**、しかも cmd.exe の `>>` は書き込み共有を許さずに
 * ログを開く。結果、取りこぼした旧インスタンスがログを掴んでいると次の起動の cmd.exe は
 * リダイレクト先を開けず **無出力のまま即死**し、Excubitor からは
 * `could not be verified after breakaway spawn` にしか見えなくなる (2026-08-08 GLab 起動不能)。
 *
 * そこで「起動をコマンドラインで永続化する」のをやめ、この launcher に置き換えた
 * (neco 裁定 2026-08-08)。launcher は WMI から Job 外に生成され、
 *   1. ログを Node の fd (共有を許す通常の append open) で開き
 *   2. 実プロセスを spawn し
 *   3. 実 pid か spawn エラーを結果ファイルへ書いて即座に終了する。
 * 常駐するのは実プロセスだけになり、ログのロックは構造的に起きない。spawn 失敗も
 * 「無出力の即死」ではなく理由つきで supervisor に返る。
 *
 * Windows は親の終了だけでは子を道連れにしないため、detached は付けない
 * (design.md §15.1: DETACHED_PROCESS は CREATE_NO_WINDOW を無効化して窓を開く)。
 * **この前提は Node の spawn には当てはまらない** (2026-09-19 実測、design.md §17.6)。Node (libuv) は
 * `detached` なしの子を、親だけがハンドルを持つ KILL_ON_JOB_CLOSE の Job に入れるため、親が終了すると
 * 子も消える。下の 2026-08-09 の「launcher が終了すると子が消えた」もこの機構で説明でき、
 * `detached: true` が効いたのもそのためである。
 *
 * ただし **`spawn` イベント直後に launcher が終了すると子が起動に入る前に消える**
 * (2026-08-09 実測)。`spawn` は CreateProcess の成功を意味するだけで、子の初期化完了は
 * 意味しない。結果として node ランタイムのサービスが軒並み無出力で消え、supervisor からは
 * `could not be verified after breakaway spawn` にしか見えなかった。
 *
 * 2026-08-09 からは、shell を挟まない起動を `detached: true` で切り離し、shell 経由 (npm / .bat) は
 * 起動猶予だけ待って凌いでいた。だが `detached` は DETACHED_PROCESS で、サービスはコンソールを
 * 一切持たない。そのサービスが console app (git / cmd 等) を `windowsHide` 無しで起動するたびに
 * 新しいコンソールが確保され、ターミナルの窓が一瞬出ていた (2026-10-11 実測)。
 *
 * **現在の起動 (design.md §17.7)**: 実プロセスは CreateProcessW の `CREATE_NO_WINDOW` で起動し
 * (`hidden-console-spawn.ts`)、**窓の無いコンソール**を持たせる。子孫はそれを継承するので窓が出ない。
 * CreateProcessW を呼ぶヘルパーは launcher の libuv Job に入るが、その Job は SILENT_BREAKAWAY_OK
 * なので実プロセスは Job に入らない。**不変条件「子は launcher の寿命に依存しない」** は
 * shell 経由でも構造的に満たされ、起動猶予の待ちは要らなくなった (cmd.exe も実サービスの親として残る)。
 * ログはヘルパーが共有を許す append で開いて std ハンドルとして渡すので、ロックも起きない。
 *
 * supervisor 再起動後の再採用は `reconcile.ts` が永続化した pid + 起動時刻の identity 照合で行う
 * (子は Job 外に残るため見つかる)。
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';

import { spawnWithHiddenConsole, type HiddenConsoleSpawnRequest } from './hidden-console-spawn.js';

/** launcher へ spec を渡す env 名 (コマンドラインには載せない)。 */
export const BREAKAWAY_SPEC_ENV = 'EXCUBITOR_BREAKAWAY_SPEC';

export interface BreakawayLaunchSpec {
  /** 実行するコマンド (shell=false なら実行ファイルそのもの)。 */
  command: string;
  args: string[];
  /** npm / .bat 解決のため cmd.exe を挟むか (child 戦略の shell 判定と同じ)。 */
  shell: boolean;
  cwd?: string;
  stdoutPath: string;
  stderrPath: string;
  /** 実 pid または spawn エラーを書き出す先。 */
  resultPath: string;
}

/** launcher が結果ファイルへ書く内容。 */
export type BreakawayLaunchResult = { pid: number } | { error: string };

/** env から spec を取り出し、子へ渡す env (spec を除いたもの) と一緒に返す。 */
export function readLaunchSpec(env: NodeJS.ProcessEnv): {
  spec: BreakawayLaunchSpec;
  childEnv: Record<string, string>;
} {
  // Windows の env 名は大文字小文字を区別しない。通常の object として渡されたテスト値や
  // WMI の env block に大小文字違いが共存しても、正規名を優先して全 variant を子から落とす。
  const encoded =
    env[BREAKAWAY_SPEC_ENV]
    ?? Object.entries(env).find(
      ([key, value]) => key.toUpperCase() === BREAKAWAY_SPEC_ENV && typeof value === 'string',
    )?.[1];
  if (!encoded) throw new Error(`${BREAKAWAY_SPEC_ENV} is not set; nothing to launch`);
  const spec = parseLaunchSpec(Buffer.from(encoded, 'base64').toString('utf8'));
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // spec 自体は子へ継承させない (子から見れば無関係な制御情報)。
    if (key.toUpperCase() === BREAKAWAY_SPEC_ENV || typeof value !== 'string') continue;
    childEnv[key] = value;
  }
  return { spec, childEnv };
}

/** spec の JSON を検証する。壊れた spec で silently 何か別のものを起動しない。 */
export function parseLaunchSpec(json: string): BreakawayLaunchSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error('breakaway launch spec is not valid JSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('breakaway launch spec must be a JSON object');
  }
  const record = parsed as Partial<BreakawayLaunchSpec>;
  const requireString = (key: 'command' | 'stdoutPath' | 'stderrPath' | 'resultPath'): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`breakaway launch spec is missing ${key}`);
    }
    return value;
  };
  if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('breakaway launch spec args must be an array of strings');
  }
  if (typeof record.shell !== 'boolean') {
    throw new Error('breakaway launch spec shell must be a boolean');
  }
  if (record.cwd !== undefined && typeof record.cwd !== 'string') {
    throw new Error('breakaway launch spec cwd must be a string when present');
  }
  return {
    command: requireString('command'),
    args: record.args as string[],
    shell: record.shell,
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    stdoutPath: requireString('stdoutPath'),
    stderrPath: requireString('stderrPath'),
    resultPath: requireString('resultPath'),
  };
}

/**
 * 結果ファイルは supervisor が「出現したら読む」ので、部分書き込みを読ませない。
 * 一時名で書いてから rename する (同一ディレクトリなので原子的)。
 */
export function writeLaunchResult(resultPath: string, result: BreakawayLaunchResult): void {
  const temporaryPath = `${resultPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(result), 'utf8');
  renameSync(temporaryPath, resultPath);
}

/** 実プロセスの起動口 (テスト用に差し替えられる)。実 pid を返し、失敗は throw する。 */
export type StartChild = (request: HiddenConsoleSpawnRequest) => Promise<number>;

/**
 * 既定の起動口。win32 は窓の無いコンソールを持たせて CreateProcessW で起動する
 * (hidden-console-spawn.ts、design.md §17.7)。launcher は win32 専用だが、POSIX でも
 * ライブラリとしてテストできるよう、それ以外は Node の detached spawn で起動する。
 */
export const defaultStartChild: StartChild = (request) =>
  process.platform === 'win32' ? spawnWithHiddenConsole(request) : spawnDetachedWithNode(request);

/** 実プロセスを起動し、結果を書いて終了する。戻り値は launcher の exit code。 */
export async function launchBreakawayChild(
  spec: BreakawayLaunchSpec,
  childEnv: Record<string, string>,
  startChild: StartChild = defaultStartChild,
): Promise<number> {
  try {
    const pid = await startChild({
      command: spec.command,
      args: spec.args,
      shell: spec.shell,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: childEnv,
      stdoutPath: spec.stdoutPath,
      stderrPath: spec.stderrPath,
    });
    writeLaunchResult(spec.resultPath, { pid });
    return 0;
  } catch (error) {
    writeLaunchResult(spec.resultPath, {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function spawnDetachedWithNode(request: HiddenConsoleSpawnRequest): Promise<number> {
  const stdoutFd = openSync(request.stdoutPath, 'a');
  const stderrFd = openSync(request.stderrPath, 'a');
  try {
    const child = spawn(request.command, request.args, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      shell: request.shell,
      env: request.env,
      stdio: ['ignore', stdoutFd, stderrFd],
      detached: true,
      windowsHide: true,
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('spawn', () => {
        if (child.pid === undefined) reject(new Error('child process started without a pid'));
        else resolve(child.pid);
      });
      child.once('error', (error: Error) => reject(error));
    });
    child.unref();
    return pid;
  } finally {
    // 子は複製したハンドルを持つので、launcher 側は閉じてよい。
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}
