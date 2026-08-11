/**
 * npm CLI 呼び出しとレジストリメタデータ取得を 1 か所に閉じる。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { execCapture } from '../../shared/exec.js';
import type { NpmOutdatedMap } from './types.js';

export interface NpmInvocation {
  command: string;
  prefixArgs: string[];
}

export interface NpmCommandFailure {
  code: string;
  message: string;
}

export type NpmCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: NpmCommandFailure };

interface NpmListJson {
  dependencies?: Record<string, { version?: string; resolved?: string }>;
}

export interface InstalledGlobalPackage {
  version: string | null;
  resolved: string | null;
}

export interface NpmPackageMetadata {
  repository?: string | { type?: string; url?: string; directory?: string };
}

export function resolveNpmInvocation(): NpmInvocation {
  const candidates = [
    process.env.EXCUBITOR_NPM_CLI,
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  const npmCli = candidates.find((candidate) => existsSync(resolve(candidate)));
  if (!npmCli) {
    throw new Error(
      'npm CLI entrypoint not found; set EXCUBITOR_NPM_CLI to npm-cli.js',
    );
  }
  return { command: process.execPath, prefixArgs: [resolve(npmCli)] };
}

export async function npmOutdated(
  invocation: NpmInvocation,
  cwd: string,
  timeoutMs: number,
  global: boolean,
): Promise<NpmCommandResult<NpmOutdatedMap>> {
  const args = [...invocation.prefixArgs, 'outdated', '--json'];
  if (global) args.push('--global', '--depth=0');
  return runNpmJson<NpmOutdatedMap>(invocation.command, args, cwd, timeoutMs, new Set([0, 1]));
}

export async function npmGlobalPackages(
  invocation: NpmInvocation,
  cwd: string,
  timeoutMs: number,
): Promise<NpmCommandResult<Record<string, InstalledGlobalPackage>>> {
  const result = await runNpmJson<NpmListJson>(
    invocation.command,
    [...invocation.prefixArgs, 'ls', '--global', '--depth=0', '--json'],
    cwd,
    timeoutMs,
    new Set([0, 1]),
  );
  if (!result.ok) return result;
  const packages: Record<string, InstalledGlobalPackage> = {};
  for (const [name, dependency] of Object.entries(result.value.dependencies ?? {})) {
    packages[name] = {
      version: dependency.version ?? null,
      resolved: dependency.resolved ?? null,
    };
  }
  return { ok: true, value: packages };
}

export async function npmGlobalRoot(
  invocation: NpmInvocation,
  cwd: string,
  timeoutMs: number,
): Promise<NpmCommandResult<string>> {
  const result = await execCapture(
    invocation.command,
    [...invocation.prefixArgs, 'root', '--global'],
    cwd,
    timeoutMs,
  );
  if (!result.ok || !result.stdout.trim()) {
    return {
      ok: false,
      failure: {
        code: 'npm_global_root_failed',
        message: sanitizeNpmDiagnostic(
          result.stderr.trim() || `npm root exited ${String(result.code)}`,
          cwd,
        ),
      },
    };
  }
  return { ok: true, value: resolve(result.stdout.trim()) };
}

export async function npmLatestVersion(
  invocation: NpmInvocation,
  cwd: string,
  timeoutMs: number,
  packageName: string,
): Promise<NpmCommandResult<string>> {
  return runNpmJson<string>(
    invocation.command,
    [...invocation.prefixArgs, 'view', packageName, 'version', '--json'],
    cwd,
    timeoutMs,
    new Set([0]),
  );
}

export async function npmPackageMetadata(
  invocation: NpmInvocation,
  cwd: string,
  timeoutMs: number,
  packageName: string,
  version: string,
): Promise<NpmCommandResult<NpmPackageMetadata>> {
  return runNpmJson<NpmPackageMetadata>(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'view',
      `${packageName}@${version}`,
      'repository',
      // Keep a second field so npm returns an object keyed by field name. Homepage is discarded.
      'homepage',
      '--json',
    ],
    cwd,
    timeoutMs,
    new Set([0]),
  );
}

export interface NpmAuditAdvisory {
  title?: string;
  url?: string;
}

export interface NpmAuditVulnerability {
  severity?: string;
  range?: string;
  via?: Array<string | NpmAuditAdvisory>;
  fixAvailable?: boolean | {
    name?: string;
    version?: string;
    isSemVerMajor?: boolean;
  };
}

export interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

export async function npmAudit(
  invocation: NpmInvocation,
  cwd: string,
  timeoutMs: number,
): Promise<NpmCommandResult<NpmAuditReport>> {
  return runNpmJson<NpmAuditReport>(
    invocation.command,
    [...invocation.prefixArgs, 'audit', '--json'],
    cwd,
    timeoutMs,
    new Set([0, 1]),
  );
}

async function runNpmJson<T>(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  acceptedCodes: Set<number>,
): Promise<NpmCommandResult<T>> {
  const result = await execCapture(command, args, cwd, timeoutMs);
  if (result.code === null || !acceptedCodes.has(result.code)) {
    return {
      ok: false,
      failure: {
        code: 'npm_command_failed',
        message: sanitizeNpmDiagnostic(
          result.stderr.trim() || `npm exited ${String(result.code)}`,
          cwd,
        ),
      },
    };
  }
  const raw = result.stdout.trim() || '{}';
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: 'npm_json_invalid',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function sanitizeNpmDiagnostic(message: string, cwd: string): string {
  let sanitized = message;
  for (const [path, label] of [[cwd, '[audit-target]'], [homedir(), '[home]']] as const) {
    if (!path) continue;
    sanitized = sanitized.replaceAll(path, label).replaceAll(path.replaceAll('\\', '/'), label);
  }
  return sanitized
    .replace(/\b(?:_authToken|npm_token|password|authorization)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
}
