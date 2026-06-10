/**
 * 組み立て済みバンドル dir を zip にする。 Windows は PowerShell Compress-Archive、
 * それ以外は zip / tar を使う (追加依存なし)。
 */

import { dirname, basename } from 'node:path';
import { execCapture } from '../shared/exec.js';

export interface ArchiveResult {
  ok: boolean;
  zipPath: string;
  stderr: string;
}

export async function archiveBundle(bundleDir: string, zipPath: string): Promise<ArchiveResult> {
  const parent = dirname(bundleDir);
  const leaf = basename(bundleDir);

  let r;
  if (process.platform === 'win32') {
    // Compress-Archive は宛先が存在すると失敗するので -Force。 中身だけ入れたいので \*。
    const ps = `Compress-Archive -Path '${bundleDir}\\*' -DestinationPath '${zipPath}' -Force`;
    r = await execCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], parent, 600000);
  } else {
    // zip 優先 (無ければ tar の zip 非対応なので sh で zip を試す)。
    r = await execCapture('sh', ['-c', `cd '${parent}' && zip -rq '${zipPath}' '${leaf}'`], parent, 600000, false);
  }
  return { ok: r.ok, zipPath, stderr: r.ok ? '' : r.stderr.slice(-2000) };
}
