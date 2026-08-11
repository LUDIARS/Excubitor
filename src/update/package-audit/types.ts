/**
 * パッケージ監査レポートの構造型。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

export type PackageAuditScope = 'local' | 'global';
export type PackageUpdateCategory = 'safe' | 'major' | 'native';
export type SemverImpact = 'safe' | 'breaking';

export interface PackageUpdate {
  scope: PackageAuditScope;
  target: string;
  projects: string[];
  packageName: string;
  current: string | null;
  wanted: string | null;
  latest: string;
  category: PackageUpdateCategory;
  semverImpact: SemverImpact;
  requiresRebuild: boolean;
  nativeReasons: string[];
  dependencyType: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
}

export type GlobalCliStatus = 'current' | 'outdated' | 'missing' | 'unverifiable';

export interface GlobalCliInventory {
  id: string;
  command: string;
  packageName: string | null;
  current: string | null;
  latest: string | null;
  status: GlobalCliStatus;
  source: 'npm-global' | 'command' | 'missing';
}

export interface PackageAuditIssue {
  scope: PackageAuditScope;
  target: string;
  code: string;
  message: string;
}

export interface PackageVulnerability {
  packageName: string;
  severity: string;
  projects: string[];
  range: string;
  fixVersion: string | null;
  isBreakingFix: boolean;
  advisoryTitles: string[];
  advisoryUrls: string[];
}

export interface PackageAuditSummary {
  safe: number;
  major: number;
  native: number;
  total: number;
  localTargets: number;
  globalPackages: number;
  vulnerabilities: number;
  issues: number;
}

export interface PackageAuditReport {
  capturedAt: string;
  summary: PackageAuditSummary;
  updates: PackageUpdate[];
  vulnerabilities: PackageVulnerability[];
  globalCli: GlobalCliInventory[];
  issues: PackageAuditIssue[];
}

export interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  location?: string;
  type?: string;
}

export type NpmOutdatedMap = Record<string, NpmOutdatedEntry>;
