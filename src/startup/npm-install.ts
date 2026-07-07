import { execCapture } from '../shared/exec.js';
import { writeDiagnostic } from '../shared/diagnostic-log.js';

export interface StartupNpmIssue {
  summary: string;
  detail: string;
}

export interface NpmAuditSummary {
  total: number;
  vulnerabilities: Record<string, number>;
}

export interface StartupNpmResult {
  installOk: boolean;
  auditOk: boolean;
  audit: NpmAuditSummary | null;
  issues: StartupNpmIssue[];
}

export async function runStartupNpmInstallAndAudit(cwd = process.cwd()): Promise<StartupNpmResult> {
  const issues: StartupNpmIssue[] = [];
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  logInfo('running startup npm install', { cwd });
  const install = await execCapture(npm, ['install'], cwd, 600_000);
  if (!install.ok) {
    const detail = tail(install.stderr || install.stdout || 'npm install failed');
    const issue = { summary: 'Excubitor startup npm install failed', detail };
    issues.push(issue);
    logError(issue.summary, { cwd, exit_code: install.code, detail });
    writeDiagnostic('startup.npm.install.failed', { cwd, exit_code: install.code, detail });
  } else {
    logInfo('startup npm install complete', { cwd });
  }

  logInfo('running startup npm audit', { cwd });
  const auditResult = await execCapture(npm, ['audit', '--json'], cwd, 300_000);
  const audit = parseNpmAuditSummary(auditResult.stdout);
  if (audit && audit.total > 0) {
    const detail = JSON.stringify(audit.vulnerabilities);
    const issue = { summary: `Excubitor npm audit found ${audit.total} vulnerabilities`, detail };
    issues.push(issue);
    logError(issue.summary, { cwd, vulnerabilities: audit.vulnerabilities });
    writeDiagnostic('startup.npm.audit.vulnerabilities', { cwd, audit });
  } else if (!auditResult.ok) {
    const detail = tail(auditResult.stderr || auditResult.stdout || 'npm audit failed');
    const issue = { summary: 'Excubitor startup npm audit failed', detail };
    issues.push(issue);
    logError(issue.summary, { cwd, exit_code: auditResult.code, detail });
    writeDiagnostic('startup.npm.audit.failed', { cwd, exit_code: auditResult.code, detail });
  } else {
    logInfo('startup npm audit complete: no vulnerabilities', { cwd });
  }

  return {
    installOk: install.ok,
    auditOk: auditResult.ok || (audit != null && audit.total > 0),
    audit,
    issues,
  };
}

export function parseNpmAuditSummary(raw: string): NpmAuditSummary | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as {
      metadata?: {
        vulnerabilities?: Record<string, unknown>;
      };
    };
    const vulnerabilities = parsed.metadata?.vulnerabilities;
    if (!vulnerabilities) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(vulnerabilities)) {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
    const total = Number(out.total ?? Object.entries(out)
      .filter(([key]) => key !== 'total')
      .reduce((sum, [, value]) => sum + value, 0));
    return { total, vulnerabilities: { ...out, total } };
  } catch {
    return null;
  }
}

function tail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 2000 ? trimmed.slice(-2000) : trimmed;
}

function logInfo(message: string, data: Record<string, unknown>): void {
  console.info(`[excubitor.startup.npm] ${message}`, data);
}

function logError(message: string, data: Record<string, unknown>): void {
  console.error(`[excubitor.startup.npm] ${message}`, data);
}
