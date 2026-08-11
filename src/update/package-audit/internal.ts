/**
 * 監査パート同士を合成するための内部集計プリミティブ。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import type {
  GlobalCliInventory,
  PackageAuditIssue,
  PackageUpdate,
  PackageVulnerability,
} from './types.js';

export interface PartialAudit {
  updates: PackageUpdate[];
  vulnerabilities: PackageVulnerability[];
  globalCli: GlobalCliInventory[];
  issues: PackageAuditIssue[];
  localTargets: number;
  globalPackages: number;
}

export function emptyAudit(): PartialAudit {
  return {
    updates: [],
    vulnerabilities: [],
    globalCli: [],
    issues: [],
    localTargets: 0,
    globalPackages: 0,
  };
}

export function combineAudits(parts: PartialAudit[]): PartialAudit {
  return parts.reduce<PartialAudit>((combined, part) => ({
    updates: [...combined.updates, ...part.updates],
    vulnerabilities: [...combined.vulnerabilities, ...part.vulnerabilities],
    globalCli: [...combined.globalCli, ...part.globalCli],
    issues: [...combined.issues, ...part.issues],
    localTargets: combined.localTargets + part.localTargets,
    globalPackages: combined.globalPackages + part.globalPackages,
  }), emptyAudit());
}

export function auditIssue(
  scope: 'local' | 'global',
  target: string,
  code: string,
  message: string,
): PackageAuditIssue {
  return { scope, target, code, message };
}
