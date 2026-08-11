/**
 * catalog 管理下の各作業ディレクトリで npm outdated / audit を回す。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog } from '../../catalog/loader.js';
import { auditIssue, type PartialAudit } from './internal.js';
import { npmAudit, npmOutdated, type NpmInvocation } from './npm-client.js';
import { packageTargetsFromCatalog } from './targets.js';
import { localPackageUpdate, localTargetLabel } from './update-factory.js';
import { vulnerabilitiesFromAudit } from './vulnerability.js';

export async function auditLocalPackages(
  catalog: Catalog,
  invocation: NpmInvocation,
  timeoutMs: number,
  concurrency: number,
): Promise<PartialAudit> {
  const targets = packageTargetsFromCatalog(catalog);
  const audit: PartialAudit = {
    updates: [],
    vulnerabilities: [],
    globalCli: [],
    issues: [],
    localTargets: targets.length,
    globalPackages: 0,
  };
  const queue = [...targets];

  async function worker(): Promise<void> {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      const outdatedPromise = npmOutdated(invocation, target.cwd, timeoutMs, false);
      const vulnerabilityPromise = existsSync(join(target.cwd, 'package-lock.json'))
        ? npmAudit(invocation, target.cwd, timeoutMs)
        : null;
      const [outdated, vulnerabilities] = await Promise.all([outdatedPromise, vulnerabilityPromise]);
      if (!outdated.ok) {
        audit.issues.push(auditIssue(
          'local',
          localTargetLabel(target),
          outdated.failure.code,
          outdated.failure.message,
        ));
      } else {
        for (const [packageName, entry] of Object.entries(outdated.value)) {
          const update = localPackageUpdate(target, packageName, entry);
          if (update) audit.updates.push(update);
        }
      }
      if (!vulnerabilityPromise) {
        audit.issues.push(auditIssue(
          'local',
          localTargetLabel(target),
          'npm_audit_lock_missing',
          'package-lock.json is missing; npm audit was not run',
        ));
      } else if (vulnerabilities && !vulnerabilities.ok) {
        audit.issues.push(auditIssue(
          'local',
          localTargetLabel(target),
          vulnerabilities.failure.code,
          vulnerabilities.failure.message,
        ));
      } else if (vulnerabilities?.ok) {
        audit.vulnerabilities.push(...vulnerabilitiesFromAudit(vulnerabilities.value, target.projects));
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, queue.length)) },
    () => worker(),
  ));
  return audit;
}
