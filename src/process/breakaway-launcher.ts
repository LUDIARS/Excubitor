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
 * Windows は親の終了で子を道連れにしないため、detached は付けない
 * (design.md §15.1: DETACHED_PROCESS は CREATE_NO_WINDOW を無効化して窓を開く)。
 *
 * ただし **`spawn` イベント直後に launcher が終了すると子が起動に入る前に消える**
 * (2026-08-09 実測)。`spawn` は CreateProcess の成功を意味するだけで、子の初期化完了は
 * 意味しない。結果として node ランタイムのサービスが軒並み無出力で消え、supervisor からは
 * `could not be verified after breakaway spawn` にしか見えなかった。
 *
 * 対処は 2 段。**不変条件は「子は launcher の寿命に依存しない」こと**なので、
 *   1. `shell` を挟まない起動 (= サービスの大半) は `detached: true` で構造的に切り離す。
 *      launcher が即終了しても子は生き残り、ログ fd もそのまま効く。
 *   2. `shell` 経由 (npm / .bat) だけは `detached` を付けられない。DETACHED_PROCESS の
 *      cmd.exe はコンソールを持たず、その子へ std ハンドルを渡せなくなるため
 *      **ログが落ちる** (2026-08-09 実測: 子は生き残るが stdout が空になる)。
 *      こちらは起動猶予だけ待って凌ぐ。
 *
 * どちらの経路でも、supervisor 再起動後の再採用は `reconcile.ts` が
 * 永続化した pid + 起動時刻の identity 照合で行う (子は Job 外に残るため見つかる)。
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';

/** launcher へ spec を渡す env 名 (コマンドラインには載せない)。 */
export const BREAKAWAY_SPEC_ENV = 'EXCUBITOR_BREAKAWAY_SPEC';

/**
 * `spawn` 後に子の生存を確かめる猶予 (ms)。supervisor 側の結果待ち
 * (`DEFAULT_RESULT_TIMEOUT_MS` = 20s) に対して十分短く取る。
 */
export const CHILD_SETTLE_TIMEOUT_MS = 750;

/** 生存確認の間隔 (ms)。 */
export const CHILD_SETTLE_INTERVAL_MS = 50;

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

/** 生存確認の差し替え口 (テスト用)。 */
export interface ChildSettleDeps {
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_SETTLE_DEPS: ChildSettleDeps = {
  isAlive: (pid) => {
    try {
      // signal 0 は送信せず存在確認だけを行う。権限が無い場合は EPERM = 生存。
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * 子が起動に入るまで launcher を生かしておく。
 *
 * 猶予を待ち切るのが本質だが、子が既に終了しているなら待つ意味は無いので早く抜ける
 * (`node -e 'process.stdout.write("x")'` のような短命コマンドで無駄に待たない)。
 * 「消えた = 失敗」とは扱わない。正常終了と起動前の消失を pid の生死だけでは
 * 区別できないため、その判定は supervisor 側の identity 照合に任せる。
 */
export async function awaitChildStartup(
  pid: number,
  deps: ChildSettleDeps = DEFAULT_SETTLE_DEPS,
  timeoutMs = CHILD_SETTLE_TIMEOUT_MS,
  intervalMs = CHILD_SETTLE_INTERVAL_MS,
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (!deps.isAlive(pid)) return;
    await deps.sleep(intervalMs);
  }
}

/** 実プロセスを起動し、結果を書いて終了する。戻り値は launcher の exit code。 */
export async function launchBreakawayChild(
  spec: BreakawayLaunchSpec,
  childEnv: Record<string, string>,
  deps: ChildSettleDeps = DEFAULT_SETTLE_DEPS,
): Promise<number> {
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    // Node の open は共有を許すため、旧インスタンスが同じログを掴んでいても開ける
    // (cmd.exe の `>>` と違ってここでロックしない)。
    stdoutFd = openSync(spec.stdoutPath, 'a');
    stderrFd = openSync(spec.stderrPath, 'a');
    const child = spawn(spec.command, spec.args, {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      shell: spec.shell,
      env: childEnv,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      // launcher の寿命に子をぶら下げない (§17.4.1)。shell 経由のときは付けられない —
      // DETACHED_PROCESS の cmd.exe はコンソールを持たず、その子へ std ハンドルを
      // 渡せなくなるためログが落ちる (2026-08-09 実測)。そちらは待ちで凌ぐ。
      detached: !spec.shell,
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('spawn', () => {
        if (child.pid === undefined) {
          reject(new Error('child process started without a pid'));
          return;
        }
        resolve(child.pid);
      });
      child.once('error', (error: Error) => reject(error));
    });
    // launcher の event loop を子に縛られないようにする。Windows は親の終了で
    // 子を道連れにしないので、これで実プロセスだけが Job 外に残る。
    child.unref();
    // shell 経由は `detached` を付けられないため、launcher の即終了で子が失われる。
    // 起動猶予だけ待ってから結果を書く。detached で切り離せている経路では不要。
    if (spec.shell) await awaitChildStartup(pid, deps);
    writeLaunchResult(spec.resultPath, { pid });
    return 0;
  } catch (error) {
    writeLaunchResult(spec.resultPath, {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    // 子は複製したハンドルを持つので、launcher 側は閉じてよい。
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 閉じられなくても launcher は終了する。子の出力には影響しない。
        }
      }
    }
  }
}

