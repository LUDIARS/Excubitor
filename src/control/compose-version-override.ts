import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load } from 'js-yaml';

import type { Service } from '../catalog/loader.js';
import { SERVICE_VERSION_ENV, VITE_SERVICE_VERSION_ENV } from '../process/service-version.js';

export interface ComposeVersionOverride {
  path: string;
  /** @implements SPEC-SERVICE-RUNTIME-VERSION */
  dispose(): Promise<void>;
}

interface ComposeDocument {
  services?: Record<string, unknown>;
}

/**
 * Create a short-lived Compose override that injects the service version into
 * every container in the compose project. Passing an env only to the docker
 * CLI is insufficient because Compose does not forward arbitrary CLI env to
 * containers by default.
 *
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */
export async function createComposeVersionOverride(
  svc: Service,
  version: string,
): Promise<ComposeVersionOverride> {
  if (!svc.compose_file) throw new Error(`service ${svc.code} has no compose_file`);
  if (!version.trim()) throw new Error(`service ${svc.code} has an empty ${SERVICE_VERSION_ENV}`);

  const serviceNames = await composeServiceNames(svc, svc.compose_file);
  if (serviceNames.length === 0) {
    throw new Error(`service ${svc.code} compose file declares no services for ${SERVICE_VERSION_ENV} injection`);
  }

  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), 'excubitor-compose-version-'));
  } catch {
    throw new Error(`failed to create compose version override for service ${svc.code}`);
  }
  const path = join(directory, 'compose.version.override.yaml');
  try {
    await writeFile(path, renderOverride(serviceNames, version), 'utf8');
  } catch {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new Error(`failed to create and clean up compose version override for service ${svc.code}`);
    }
    throw new Error(`failed to create compose version override for service ${svc.code}`);
  }

  return {
    path,
    /** @implements SPEC-SERVICE-RUNTIME-VERSION */
    async dispose(): Promise<void> {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // The temporary directory may include a local account name. Keep its
        // absolute path out of API/audit diagnostics while still failing loud.
        throw new Error(`failed to remove compose version override for service ${svc.code}`);
      }
    },
  };
}

/** @implements SPEC-SERVICE-RUNTIME-VERSION */
async function composeServiceNames(svc: Service, composeFile: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(composeFile, 'utf8');
  } catch {
    throw new Error(`service ${svc.code} compose file could not be read for runtime version injection`);
  }
  let parsed: ComposeDocument | null;
  try {
    parsed = load(raw) as ComposeDocument | null;
  } catch {
    // YAML parser errors can quote the source line, which may contain secrets.
    throw new Error(`service ${svc.code} compose file is invalid YAML for runtime version injection`);
  }
  const services = parsed?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error(`service ${svc.code} compose file has no services mapping`);
  }
  return Object.keys(services);
}

/** @implements SPEC-SERVICE-RUNTIME-VERSION */
function renderOverride(serviceNames: string[], version: string): string {
  const lines = ['services:'];
  for (const name of serviceNames) {
    lines.push(`  ${JSON.stringify(name)}:`);
    lines.push('    environment:');
    lines.push(`      ${SERVICE_VERSION_ENV}: ${JSON.stringify(version)}`);
    lines.push(`      ${VITE_SERVICE_VERSION_ENV}: ${JSON.stringify(version)}`);
  }
  return `${lines.join('\n')}\n`;
}
