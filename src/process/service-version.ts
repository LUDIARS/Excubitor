import { dirname } from 'node:path';

import type { Service } from '../catalog/loader.js';
import { readGitInfo } from '../scanner/git.js';

export const SERVICE_VERSION_ENV = 'EXCUBITOR_SERVICE_VERSION';
export const VITE_SERVICE_VERSION_ENV = 'VITE_EXCUBITOR_SERVICE_VERSION';

export type ServiceVersionSource = 'package' | 'git' | 'unversioned';

export interface ServiceRuntimeVersion {
  value: string;
  source: ServiceVersionSource;
}

export interface VersionedEnvironment {
  env: Record<string, string>;
  version: ServiceRuntimeVersion;
}

/**
 * Resolve the directory that represents a service's source checkout.
 *
 * The catalog is authoritative for launch details, so this deliberately does
 * not search parent directories or make workspace-wide guesses.
 *
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */
function serviceVersionDirectory(svc: Service): string | null {
  if (svc.cwd) return svc.cwd;
  if (svc.compose_file) return dirname(svc.compose_file);
  if (svc.exec) return dirname(svc.exec);
  if (svc.start_script) return dirname(svc.start_script);
  return null;
}

/**
 * Resolve a non-secret, always-present runtime version for a service.
 *
 * A declared package version is preferred. Repositories without a package
 * manifest still get a stable Git-derived SemVer build identifier. The final
 * marker intentionally remains explicit rather than silently dropping the
 * variable when no source metadata is available.
 *
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */
export async function resolveServiceRuntimeVersion(svc: Service): Promise<ServiceRuntimeVersion> {
  const cwd = serviceVersionDirectory(svc);
  if (!cwd) return { value: '0.0.0+unversioned', source: 'unversioned' };

  const git = await readGitInfo(cwd);
  const packageVersion = normalizedVersionComponent(git.package_version);
  if (packageVersion) return { value: packageVersion, source: 'package' };
  const gitHash = normalizedVersionComponent(git.hash);
  if (gitHash) return { value: `0.0.0+${gitHash}`, source: 'git' };
  return { value: '0.0.0+unversioned', source: 'unversioned' };
}

/** @implements SPEC-SERVICE-RUNTIME-VERSION */
function normalizedVersionComponent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Append Excubitor's authoritative service-version value to a child env.
 *
 * This is intentionally the final merge so catalog env, injected secrets, and
 * control-call overrides cannot remove or replace the runtime identity.
 *
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */
export async function injectServiceRuntimeVersion(
  svc: Service,
  env: Record<string, string>,
): Promise<VersionedEnvironment> {
  const version = await resolveServiceRuntimeVersion(svc);
  return {
    env: {
      ...env,
      [SERVICE_VERSION_ENV]: version.value,
      // Vite deliberately exposes only VITE_-prefixed non-secret variables to
      // browser code. This mirrors the authoritative value without exposing
      // any unrelated child environment entries.
      [VITE_SERVICE_VERSION_ENV]: version.value,
    },
    version,
  };
}
