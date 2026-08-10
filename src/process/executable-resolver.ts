/**
 * サービスの `command` 先頭語を実行ファイルへ解決し、cmd.exe を挟む必要があるかを決める。
 * 正本: spec/plan/design.md §17.4.2。
 *
 * 従来は `shell: svc.runtime !== 'app'` で「app 以外は一律 shell 経由」にしていた。
 * win32 の `shell: true` は `cmd.exe /d /s /c "..."` を挟むため、
 *   - `spawnOutsideJob` が返す pid が **実サービスではなく cmd.exe** になり、
 *     §17.4 の pid 契約 (返すのは実プロセスの pid) が破れる。
 *     実測 (2026-08-09): concordia-control の worker は起動するのに、返り pid は
 *     先に消える cmd.exe だったため identity 照合が「即死」と判定し、
 *     起動のたびに Excubitor が把握しない worker が 1 本ずつ積み上がっていた。
 *   - cmd.exe は自前のコンソールを確保するため `detached` を付けられない (窓が出る)。
 *     結果として §17.4.1 の構造的な切り離しにも乗れない。
 *
 * cmd.exe が本当に要るのは `.cmd` / `.bat` を入口にするサービス (npm, start_script) だけ。
 * `node ...` のように実行ファイルへ解決できる入口は直接起動すれば、pid も窓もログも正しくなる。
 */
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve, extname } from 'node:path';

export interface ResolvedCommand {
  /** 起動に使うコマンド。直接起動時は絶対パス、batch は cmd.exe に渡す元の token。 */
  command: string;
  /** cmd.exe を挟む必要があるか。 */
  shell: boolean;
}

/** cmd.exe でしか起動できない拡張子 (Windows のバッチ)。 */
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

/** PATHEXT が読めない環境向けの既定 (Windows の標準値)。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const WINDOWS_PATH_DELIMITER = ';';

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** env から大小文字を問わず値を引く (Windows の env 名は case-insensitive)。 */
function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (typeof direct === 'string') return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * `command` を実行ファイルへ解決する。
 *
 * - 解決できて `.cmd` / `.bat` 以外 → `{ command: <絶対パス>, shell: false }`
 * - 解決できて `.cmd` / `.bat` → `{ command, shell: true }`
 * - 解決できない → `{ command, shell: true }` (従来どおり cmd.exe に委ねる。
 *   ここで throw すると、これまで起動できていた入口を落としてしまう)
 *
 * win32 以外は cmd.exe の話が無いので、常に shell 無しで直接起動する。
 */
export function resolveExecutable(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command, shell: false };

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const extensions = (lookupEnv(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(WINDOWS_PATH_DELIMITER)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const candidate of candidatePaths(command, { cwd, env, extensions })) {
    if (!isExecutableFile(candidate)) continue;
    const requiresShell = BATCH_EXTENSIONS.has(extname(candidate).toLowerCase());
    // Node joins `file` and `args` into one command string when shell=true. Replacing a
    // bare token such as `npm` with `C:\Program Files\nodejs\npm.cmd` therefore makes
    // cmd.exe parse `C:\Program` as the executable. Resolution is still authoritative for
    // deciding that this is a batch entry, but cmd.exe must receive the original token.
    return { command: requiresShell ? command : candidate, shell: requiresShell };
  }
  return { command, shell: true };
}

/** 探索順に候補パスを生成する。拡張子付きの指定はそのまま、無指定は PATHEXT を順に試す。 */
function* candidatePaths(
  command: string,
  context: { cwd: string; env: NodeJS.ProcessEnv; extensions: string[] },
): Generator<string> {
  const explicitExtension = extname(command).length > 0;
  const bases = command.includes('/') || command.includes('\\') || isAbsolute(command)
    ? [isAbsolute(command) ? command : resolve(context.cwd, command)]
    : [
        context.cwd,
        ...(lookupEnv(context.env, 'PATH') ?? '')
          .split(WINDOWS_PATH_DELIMITER)
          .map((entry) => entry.trim().replace(/^"|"$/g, ''))
          .filter((entry) => entry.length > 0)
          .map((entry) => resolve(context.cwd, entry)),
      ].map((root) => join(root, command));

  for (const base of bases) {
    if (explicitExtension) {
      yield base;
      continue;
    }
    for (const extension of context.extensions) yield `${base}${extension}`;
  }
}
