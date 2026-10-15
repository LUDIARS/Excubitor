/**
 * catalog で `ergo_watch` を付けたサービスから、 `ergo_pkg watch --host` に並べる checkout を集める。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import type { Catalog, Service } from '../../catalog/loader.js';
import { arsRoot } from '../../shared/roots.js';
import { findGitRoot } from '../steps.js';
import type { WatchHost } from './types.js';

export interface HostIssue {
  service: string;
  message: string;
}

export interface CollectedHosts {
  hosts: WatchHost[];
  issues: HostIssue[];
}

type GitRootFinder = (dir: string) => string | null;

/** `ergo_watch` が真のサービスか。 */
export function isErgoWatched(service: Service): boolean {
  return Boolean(service.ergo_watch) && !service.disabled;
}

/** 非公開ホストとして宣言されているか (`ergo_watch: { private: true }`)。 */
export function isPrivateErgoHost(service: Service): boolean {
  return typeof service.ergo_watch === 'object' && service.ergo_watch.private;
}

/**
 * checkout ごとに 1 つへ畳む。 同じ checkout を複数サービスが宣言したら、 1 つでも非公開なら非公開に倒す。
 * cwd が無い・git checkout でないサービスは issue にして除く。
 */
export function collectWatchHosts(
  catalog: Catalog,
  findRoot: GitRootFinder = (dir) => findGitRoot(dir, undefined, arsRoot()),
): CollectedHosts {
  const byDir = new Map<string, WatchHost>();
  const issues: HostIssue[] = [];
  for (const service of catalog.services) {
    if (!isErgoWatched(service)) continue;
    if (!service.cwd) {
      issues.push({ service: service.code, message: 'ergo_watch requires cwd' });
      continue;
    }
    const dir = findRoot(service.cwd);
    if (!dir) {
      issues.push({ service: service.code, message: 'cwd is not inside a git checkout' });
      continue;
    }
    const existing = byDir.get(dir);
    if (existing) {
      existing.serviceCodes.push(service.code);
      existing.private ||= isPrivateErgoHost(service);
    } else {
      byDir.set(dir, { dir, serviceCodes: [service.code], private: isPrivateErgoHost(service) });
    }
  }
  const hosts = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  return { hosts, issues };
}
