import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * `<cwd>/dev-process.md` を読み取って実行コマンドを抽出する、E
 *
 * フォーマッチE(Concordia / Excubitor 互換):
 *   ```bash
 *   <command>
 *   ```
 * Extract the contents of the first bash/sh fenced code block.
 *
 * 侁E
 *   ## Server
 *   ```bash
 *   npm run dev
 *   ```
 * ↁE"npm run dev"
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
  // Use the first non-comment line (v0.1 limitation).
  return lines[0]!;
}


