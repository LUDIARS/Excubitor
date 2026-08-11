/**
 * パッケージ監査 CLI の入口。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { loadCatalog } from '../../catalog/loader.js';
import { DEFAULT_RUNTIME_CONFIG_PATH } from '../../catalog/runtime-config.js';
import { auditPackages } from './auditor.js';
import { loadPackageAuditConfig } from './config.js';
import { sendPackageAuditDiscordReport } from './discord-report.js';
import { formatPackageAuditText } from './format.js';

interface CliOptions {
  configPath: string;
  includeLocal: boolean;
  includeGlobal: boolean;
  includeReleaseNotes: boolean;
  timeoutMs: number;
  concurrency: number;
  json: boolean;
  discord: boolean;
  failOnUpdates: boolean;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const catalog = loadCatalog(options.configPath);
  const config = loadPackageAuditConfig(options.configPath);
  const report = await auditPackages({
    catalog,
    config,
    includeLocal: options.includeLocal,
    includeGlobal: options.includeGlobal,
    includeReleaseNotes: options.includeReleaseNotes,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
  });

  if (options.discord) await sendPackageAuditDiscordReport(report);
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatPackageAuditText(report)}\n`);

  const blockingIssues = report.issues.filter((entry) => (
    entry.code !== 'npm_audit_lock_missing'
    && !entry.code.startsWith('release_notes_')
  ));
  if (blockingIssues.length > 0) process.exitCode = 1;
  else if (options.failOnUpdates && (report.updates.length > 0 || report.vulnerabilities.length > 0)) {
    process.exitCode = 2;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: process.env.EXCUBITOR_PACKAGE_AUDIT_CONFIG?.trim() || DEFAULT_RUNTIME_CONFIG_PATH,
    includeLocal: true,
    includeGlobal: true,
    includeReleaseNotes: true,
    timeoutMs: 120_000,
    concurrency: 4,
    json: false,
    discord: false,
    failOnUpdates: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--discord') options.discord = true;
    else if (argument === '--fail-on-updates') options.failOnUpdates = true;
    else if (argument === '--no-release-notes') options.includeReleaseNotes = false;
    else if (argument === '--local-only') options.includeGlobal = false;
    else if (argument === '--global-only') options.includeLocal = false;
    else if (argument === '--config') options.configPath = requiredValue(argv, ++index, argument);
    else if (argument === '--timeout-ms') {
      options.timeoutMs = positiveInteger(requiredValue(argv, ++index, argument), argument);
    } else if (argument === '--concurrency') {
      options.concurrency = positiveInteger(requiredValue(argv, ++index, argument), argument);
    } else {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
  }
  if (!options.includeLocal && !options.includeGlobal) {
    throw new Error('--local-only and --global-only cannot be used together');
  }
  return options;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`package audit failed: ${message}\n`);
  process.exitCode = 1;
});
