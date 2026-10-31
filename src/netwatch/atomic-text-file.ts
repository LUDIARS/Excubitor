/** @implements SPEC-EX-NETWATCH */
/**
 * テキストを同じディレクトリの一時ファイルへ書いてから rename で置き換える。 読む側
 * (Tela) が書きかけのファイルを読まないようにする。 内容が同じなら書かない。
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AtomicTextFile {
  private lastWritten: string | null = null;

  constructor(private readonly path: string) {}

  /** 内容が変わったときだけ書く。 書いたら true。 */
  async write(content: string): Promise<boolean> {
    if (content === this.lastWritten) return false;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8' });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => { /* 元の失敗を優先して返す */ });
      throw error;
    }
    this.lastWritten = content;
    return true;
  }
}
