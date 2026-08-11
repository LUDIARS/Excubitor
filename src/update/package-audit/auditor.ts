/**
 * ローカル + グローバル監査を束ね、release notes と脆弱性を載せた 1 レポートにする。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import type { Catalog } from '../../catalog/loader.js';
import { aggregateUpdates, countUpdateCategories } from './aggregate.js';
import type { PackageAuditConfig } from './config.js';
import { auditGlobalPackages } from './global-auditor.js';
import { combineAudits, emptyAudit } from './internal.js';
import { auditLocalPackages } from './local-auditor.js';
import { resolveNpmInvocation } from './npm-client.js';
import { enrichReleaseNotes } from './release-notes.js';
import type { PackageAuditReport } from './types.js';
import { aggregateVulnerabilities } from './vulnerability.js';

export interface PackageAuditorOptions {
  catalog: Catalog;
  config: PackageAuditConfig;
  includeLocal: boolean;
  includeGlobal: boolean;
  includeReleaseNotes: boolean;
  timeoutMs: number;
  concurrency: number;
  now?: Date;
}

export async function auditPackages(options: PackageAuditorOptions): Promise<PackageAuditReport> {
  const invocation = resolveNpmInvocation();
  const parts = await Promise.all([
    options.includeLocal
      ? auditLocalPackages(options.catalog, invocation, options.timeoutMs, options.concurrency)
      : emptyAudit(),
    options.includeGlobal
      ? auditGlobalPackages(options.config, invocation, options.timeoutMs)
      : emptyAudit(),
  ]);
  const combined = combineAudits(parts);
  let updates = aggregateUpdates(combined.updates);
  if (options.includeReleaseNotes && options.config.release_notes.enabled && updates.length > 0) {
    const enriched = await enrichReleaseNotes(updates, {
      cwd: process.cwd(),
      invocation,
      timeoutMs: options.timeoutMs,
      maxPackages: options.config.release_notes.max_packages,
    });
    updates = enriched.updates;
    combined.issues.push(...enriched.issues);
  }
  const vulnerabilities = aggregateVulnerabilities(combined.vulnerabilities);
  const categoryCounts = countUpdateCategories(updates);
  return {
    capturedAt: (options.now ?? new Date()).toISOString(),
    summary: {
      ...categoryCounts,
      total: updates.length,
      localTargets: combined.localTargets,
      globalPackages: combined.globalPackages,
      vulnerabilities: vulnerabilities.length,
      issues: combined.issues.length,
    },
    updates,
    vulnerabilities,
    globalCli: combined.globalCli.sort((a, b) => a.id.localeCompare(b.id)),
    issues: combined.issues,
  };
}
