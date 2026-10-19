import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readMeshSecurityConfig } from './config.js';
import {
  LegacyMonitorMigrationSchema,
  resolveMeshAuthPolicy,
  type LegacyMonitorMigration,
  type MeshAuthPolicy,
} from './legacy-monitor.js';

/**
 * File adapter for the migration switch. It lives next to the agent token (outside the
 * repository, per account) so a git update never enables or disables it.
 *
 * @implements SPEC-SECURITY-MESH-LEGACY-MONITOR
 */

export function legacyMonitorMigrationPath(): string {
  const override = process.env.EXCUBITOR_MESH_LEGACY_MONITOR_FILE;
  if (override) return override;
  const base = process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'Excubitor', 'mesh-legacy-monitor.json');
}

/** Read on each request like the mesh security file: disabling takes effect without restart. */
export function readLegacyMonitorMigration(path = legacyMonitorMigrationPath()): LegacyMonitorMigration | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('legacy_monitor_migration_unreadable');
  }
  const parsed = LegacyMonitorMigrationSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('legacy_monitor_migration_invalid');
  return parsed.data;
}

export function enableLegacyMonitorMigration(reason: string, now = new Date(), path = legacyMonitorMigrationPath()): LegacyMonitorMigration {
  const migration = LegacyMonitorMigrationSchema.parse({ version: 1, mode: 'legacy-monitor', enabled_at: now.toISOString(), reason });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(migration, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return migration;
}

export function disableLegacyMonitorMigration(path = legacyMonitorMigrationPath()): void {
  rmSync(path, { force: true });
}

export function readMeshAuthPolicy(): MeshAuthPolicy {
  return resolveMeshAuthPolicy({ loadConfig: readMeshSecurityConfig, loadMigration: () => readLegacyMonitorMigration() });
}
