/**
 * この Excubitor プロセスが起動したときの checkout の状態 (branch / hash) と起動時刻。
 *
 * 拠点情報に出すほか、 自身への「反映」依頼でディスクの HEAD と比べ、 走っている版とずれて
 * いるときだけ build + 再起動するのに使う。 起動後にディスクが進んでも値は変えない
 * (「このプロセスが読み込んだ版」 を表すため)。
 */

import { locateGitCheckout, readGitHead } from '../scanner/git-fs.js';

/** @implements SPEC-FEDERATION-NODE-INFO */

export interface SelfVersion {
  dir: string;
  branch: string | null;
  hash: string | null;
  startedAt: number;
}

let current: SelfVersion | null = null;

/** 起動時に 1 回だけ呼ぶ。 checkout が読めなくても起動は止めない (branch / hash が null になる)。 */
export async function captureSelfVersion(dir: string, startedAt = Date.now()): Promise<SelfVersion> {
  const head = await readCurrentHead(dir);
  current = { dir, branch: head.branch, hash: head.hash, startedAt };
  return current;
}

export function getSelfVersion(): SelfVersion | null {
  return current;
}

/** ディスク上の今の HEAD (起動時の値とは別に、 呼ぶたびに読む)。 */
export async function readCurrentHead(dir: string): Promise<{ branch: string | null; hash: string | null }> {
  const checkout = await locateGitCheckout(dir);
  const head = checkout ? await readGitHead(checkout) : null;
  return { branch: head?.branch ?? null, hash: head?.hash ?? null };
}

/** テスト用。 */
export function resetSelfVersion(): void {
  current = null;
}
