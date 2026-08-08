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
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';

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

/** 実プロセスを起動し、結果を書いて終了する。戻り値は launcher の exit code。 */
export async function launchBreakawayChild(
  spec: BreakawayLaunchSpec,
  childEnv: Record<string, string>,
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
    // launcher の event loop を子に縛られないようにしてから抜ける。Windows は親の終了で
    // 子を道連れにしないので、これで実プロセスだけが Job 外に残る。
    child.unref();
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

