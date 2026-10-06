import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadBundle, type BundleDownloadResult } from '../federation/client.js';
import type { RemotePeer } from '../federation/store.js';
import { execCapture } from '../shared/exec.js';
import type { CheckoutCloner } from './checkout.js';

/**
 * 外部に出られない拠点 (取得元 mesh) の bootstrap: 依頼元拠点から main の bundle を丸ごと受け取って clone する。
 * clone 後は origin を GitHub の URL にそろえる (checkout の検証と、 以後の mesh 更新が同じ checkout を指すため)。
 * @implements SPEC-FEDERATION-MESH-SOURCE
 */

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface MeshCloneDeps {
  download?: (peer: RemotePeer, repo: string, have: string | null, dest: string) => Promise<BundleDownloadResult>;
  exec?: typeof execCapture;
}

export function meshCloner(peer: RemotePeer, deps: MeshCloneDeps = {}): CheckoutCloner {
  const download = deps.download ?? downloadBundle;
  const exec = deps.exec ?? execCapture;
  return async (repository, target, root) => {
    const dir = await mkdtemp(join(tmpdir(), 'excubitor-mesh-clone-'));
    const file = join(dir, 'main.bundle');
    try {
      const got = await download(peer, repository, null, file);
      if (!got.ok || got.upToDate) throw new Error('bundle from ' + peer.name + ' failed: ' + (got.error ?? 'no bundle'));
      const verify = await exec('git', ['bundle', 'list-heads', file], root, GIT_TIMEOUT_MS);
      if (!verify.ok || !/\srefs\/heads\/main$/m.test(verify.stdout)) throw new Error('bundle from ' + peer.name + ' has no main');
      const cloned = await exec('git', ['clone', '--branch', 'main', '--single-branch', '--', file, target], root, GIT_TIMEOUT_MS);
      if (!cloned.ok) throw new Error('clone from bundle failed; inspect checkout on the destination');
      const origin = await exec('git', ['remote', 'set-url', 'origin', 'https://github.com/' + repository + '.git'], target, GIT_TIMEOUT_MS);
      if (!origin.ok) throw new Error('setting origin after bundle clone failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
