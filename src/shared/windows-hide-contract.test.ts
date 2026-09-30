import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Excubitor は Scheduled Task (Windows) の常駐プロセスから子プロセスを大量に起動する。
 * windowsHide を付け忘れると、監視や自動修正のたびにコンソール窓が前面に出る
 * (2026-09 に neco から 2 度指摘)。起動呼び出しは必ず windowsHide を明示する。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
// 直前が '.' や識別子のもの (RegExp.exec 等のメソッド) は除く。
const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
    .map((path) => join(dir, path));
}

/** 呼び出しの開き括弧から対応する閉じ括弧までを返す (文字列内の括弧は稀なので無視)。 */
function callText(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(openIndex, i + 1);
  }
  return source.slice(openIndex);
}

function importsChildProcess(source: string): boolean {
  return /from ['"](node:)?child_process['"]/.test(source);
}

describe('child process launches', () => {
  it('always hide the Windows console window', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'latin1');
      if (!importsChildProcess(source)) continue;
      for (const match of source.matchAll(CALL)) {
        const before = source.slice(Math.max(0, match.index - 40), match.index);
        // 宣言・型・コメント中の語は呼び出しではない。
        if (/(function|import|type|interface|\/\/|\*)\s*[\w\s{},]*$/.test(before.split('\n').pop() ?? '')) continue;
        const text = callText(source, match.index + match[0].length - 1);
        if (!text.includes('windowsHide')) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${relative(SRC, file)}:${line} ${match[1]}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
