import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * `<cwd>/dev-process.md` を読み取って実行コマンドを抽出する。
 *
 * フォーマット (Concordia / Excubitor 互換):
 *   ```bash
 *   <command>
 *   ```
 * の最初の bash code block の中身を取り出す。
 *
 * 例:
 *   ## Server
 *   ```bash
 *   npm run dev
 *   ```
 * → "npm run dev"
 */
export async function resolveDevProcessCommand(cwd: string): Promise<string> {
  const path = resolve(cwd, 'dev-process.md');
  const raw = await readFile(path, 'utf8');
  const match = raw.match(/```(?:bash|sh)\s*\n([\s\S]*?)```/);
  if (!match) {
    throw new Error(`dev-process.md in ${cwd} has no bash code block`);
  }
  const lines = match[1]!
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new Error(`dev-process.md in ${cwd} bash block has no command`);
  }
  // 複数行はとりあえず最初の non-comment 行を採用 (v0.1 limitation)
  return lines[0]!;
}
