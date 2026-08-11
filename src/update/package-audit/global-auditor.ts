/**
 * npm ls -g の実測とカタログ宣言の必須 CLI からグローバル更新を集める。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { execCapture } from '../../shared/exec.js';
import { isBreakingVersionChange, updateCategory } from './classify.js';
import type { GlobalCliTarget, PackageAuditConfig } from './config.js';
import { auditIssue, type PartialAudit } from './internal.js';
import { detectNativePackage } from './native-detector.js';
import {
  npmGlobalPackages,
  npmGlobalRoot,
  npmLatestVersion,
  npmOutdated,
  type InstalledGlobalPackage,
  type NpmInvocation,
} from './npm-client.js';
import type {
  GlobalCliInventory,
  NpmOutdatedMap,
} from './types.js';
import { globalPackageUpdate } from './update-factory.js';

export async function auditGlobalPackages(
  config: PackageAuditConfig,
  invocation: NpmInvocation,
  timeoutMs: number,
): Promise<PartialAudit> {
  const cwd = process.cwd();
  const [installedResult, outdatedResult, rootResult] = await Promise.all([
    npmGlobalPackages(invocation, cwd, timeoutMs),
    npmOutdated(invocation, cwd, timeoutMs, true),
    npmGlobalRoot(invocation, cwd, timeoutMs),
  ]);
  const audit: PartialAudit = {
    updates: [],
    vulnerabilities: [],
    globalCli: [],
    issues: [],
    localTargets: 0,
    globalPackages: installedResult.ok ? Object.keys(installedResult.value).length : 0,
  };
  if (!installedResult.ok) {
    audit.issues.push(auditIssue(
      'global',
      'npm-global',
      installedResult.failure.code,
      installedResult.failure.message,
    ));
  }
  if (!outdatedResult.ok) {
    audit.issues.push(auditIssue(
      'global',
      'npm-global',
      outdatedResult.failure.code,
      outdatedResult.failure.message,
    ));
  }
  if (!rootResult.ok) {
    audit.issues.push(auditIssue(
      'global',
      'npm-global',
      rootResult.failure.code,
      rootResult.failure.message,
    ));
  }
  const installed = installedResult.ok ? installedResult.value : {};
  const outdated = outdatedResult.ok ? outdatedResult.value : {};
  const globalRoot = rootResult.ok ? rootResult.value : null;
  const declaredPackages = new Set(
    config.global_cli.flatMap((target) => target.npm_package ? [target.npm_package] : []),
  );
  for (const [packageName, entry] of Object.entries(outdated)) {
    if (!config.include_unlisted_npm_globals && !declaredPackages.has(packageName)) continue;
    const update = globalPackageUpdate(packageName, entry, globalRoot);
    if (update) audit.updates.push(update);
  }

  for (const target of config.global_cli) {
    const inventory = await inspectGlobalCli(target, installed, outdated, invocation, timeoutMs);
    audit.globalCli.push(inventory);
    if (inventory.status === 'missing' && target.required) {
      audit.issues.push(auditIssue(
        'global',
        target.id,
        'required_cli_missing',
        `${target.command} is not installed`,
      ));
    } else if (inventory.status === 'unverifiable') {
      audit.issues.push(auditIssue(
        'global',
        target.id,
        'cli_version_unverifiable',
        'current or latest version is unavailable',
      ));
    }
    addDeclaredCliUpdate(audit, target, inventory);
  }
  return audit;
}

function addDeclaredCliUpdate(
  audit: PartialAudit,
  target: GlobalCliTarget,
  inventory: GlobalCliInventory,
): void {
  const packageName = inventory.packageName ?? target.id;
  if (
    inventory.status !== 'outdated'
    || !inventory.latest
    || audit.updates.some((update) => update.packageName === packageName)
  ) return;
  const native = target.workspace_package
    ? detectNativePackage(dirname(resolve(target.workspace_package)))
    : { requiresRebuild: false, reasons: [] };
  const semverImpact = isBreakingVersionChange(inventory.current, inventory.latest)
    ? 'breaking'
    : 'safe';
  audit.updates.push({
    scope: 'global',
    target: target.id,
    projects: ['global'],
    packageName,
    current: inventory.current,
    wanted: inventory.latest,
    latest: inventory.latest,
    category: updateCategory(semverImpact, native.requiresRebuild),
    semverImpact,
    requiresRebuild: native.requiresRebuild,
    nativeReasons: native.reasons,
    dependencyType: 'cli',
    releaseNotes: null,
    releaseUrl: null,
  });
}

async function inspectGlobalCli(
  target: GlobalCliTarget,
  installed: Record<string, InstalledGlobalPackage>,
  outdated: NpmOutdatedMap,
  invocation: NpmInvocation,
  timeoutMs: number,
): Promise<GlobalCliInventory> {
  const npmInstalled = target.npm_package ? installed[target.npm_package] : undefined;
  // A package in npm's global inventory does not prove that its executable shim is usable.
  // Required CLI declarations promise an invokable command, so verify that boundary directly.
  const current = await commandVersion(target, timeoutMs);
  if (!current) {
    return {
      id: target.id,
      command: target.command,
      packageName: target.npm_package ?? null,
      current: null,
      latest: null,
      status: 'missing',
      source: 'missing',
    };
  }
  let latest = target.npm_package ? outdated[target.npm_package]?.latest : undefined;
  if (!latest && target.workspace_package) latest = workspacePackageVersion(target.workspace_package) ?? undefined;
  if (!latest && target.npm_package) {
    const result = await npmLatestVersion(invocation, process.cwd(), timeoutMs, target.npm_package);
    if (result.ok) latest = result.value;
  }
  return {
    id: target.id,
    command: target.command,
    packageName: target.npm_package ?? null,
    current,
    latest: latest ?? null,
    status: !latest ? 'unverifiable' : current === latest ? 'current' : 'outdated',
    source: npmInstalled ? 'npm-global' : 'command',
  };
}

async function commandVersion(target: GlobalCliTarget, timeoutMs: number): Promise<string | null> {
  let result = await execCapture(target.command, target.version_args, process.cwd(), timeoutMs);
  const canUseWindowsShim = process.platform === 'win32'
    && /^[A-Za-z0-9_.-]+$/.test(target.command)
    && target.version_args.every((argument) => /^[A-Za-z0-9_./:@=+-]+$/.test(argument));
  if (!result.ok && canUseWindowsShim) {
    // npm global binaries are .cmd shims on Windows. Restrict the fallback to shell-safe tokens
    // because the shared executor intentionally invokes .cmd files through the Windows shell.
    result = await execCapture(`${target.command}.cmd`, target.version_args, process.cwd(), timeoutMs);
  }
  if (!result.ok) return null;
  return `${result.stdout}\n${result.stderr}`
    .match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

function workspacePackageVersion(path: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(resolve(path), 'utf8')) as { version?: string };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}
