import { z } from 'zod';
import type { MeshSecurityConfig } from './config.js';

/**
 * Migration-period policy decisions (pure). The adapter that reads files lives in
 * legacy-monitor-store.ts.
 *
 * @implements SPEC-SECURITY-MESH-LEGACY-MONITOR
 */

export const MESH_SECURITY_NOT_CONFIGURED = 'mesh_security_not_configured';
export const LEGACY_MONITOR_PATHS: readonly string[] = ['/api/v1/federation/health', '/api/v1/federation/node'];

/** Written only by the administrator command (`npm run mesh:legacy-monitor -- enable`). */
export const LegacyMonitorMigrationSchema = z.object({
  version: z.literal(1),
  mode: z.literal('legacy-monitor'),
  enabled_at: z.string().datetime(),
  reason: z.string().min(1).max(500),
}).strict();
export type LegacyMonitorMigration = z.infer<typeof LegacyMonitorMigrationSchema>;

export type MeshAuthPolicy =
  | { kind: 'configured'; config: MeshSecurityConfig }
  | { kind: 'legacy-monitor-migration'; migration: LegacyMonitorMigration };

/**
 * The administrator mesh security file wins. Only its explicit absence lets the
 * explicitly enabled migration switch apply; a broken file stays an error (503).
 */
export function resolveMeshAuthPolicy(input: {
  loadConfig: () => MeshSecurityConfig;
  loadMigration: () => LegacyMonitorMigration | null;
}): MeshAuthPolicy {
  try {
    return { kind: 'configured', config: input.loadConfig() };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== MESH_SECURITY_NOT_CONFIGURED) throw error;
  }
  const migration = input.loadMigration();
  if (!migration) throw new Error(MESH_SECURITY_NOT_CONFIGURED);
  return { kind: 'legacy-monitor-migration', migration };
}

/** Shared-token peers: explicit per-peer policy, or every registered enabled peer while migrating. */
export function allowsLegacyMonitorPeer(policy: MeshAuthPolicy, peerId: string): boolean {
  return policy.kind === 'legacy-monitor-migration' || policy.config.peers[peerId]?.mode === 'legacy-monitor';
}

/** Legacy authentication never reaches operations, bundles or Vault distribution. */
export function isLegacyMonitorRequest(method: string, path: string): boolean {
  return method === 'GET' && LEGACY_MONITOR_PATHS.includes(path);
}

export interface MeshAuthStatus {
  mode: 'cr-v1' | 'legacy-monitor-migration' | 'unconfigured' | 'invalid';
  /** Peers authenticated with the legacy shared token (monitor only). null = every registered peer. */
  legacy_monitor_peers: string[] | null;
  enabled_at: string | null;
  reason: string | null;
  warning: string | null;
}

/** Status for the startup log and the management UI. Never includes credentials. */
export function describeMeshAuth(load: () => MeshAuthPolicy): MeshAuthStatus {
  let policy: MeshAuthPolicy;
  try {
    policy = load();
  } catch (error) {
    const unconfigured = error instanceof Error && error.message === MESH_SECURITY_NOT_CONFIGURED;
    return {
      mode: unconfigured ? 'unconfigured' : 'invalid',
      legacy_monitor_peers: [], enabled_at: null, reason: null,
      warning: unconfigured
        ? '拠点間認証が未設定です。他拠点からの監視・依頼はすべて拒否されます (移行中は legacy-monitor を明示的に有効化できます)'
        : '拠点間認証の設定が読めません。他拠点からの監視・依頼はすべて拒否されます',
    };
  }
  if (policy.kind === 'legacy-monitor-migration') {
    return {
      mode: 'legacy-monitor-migration', legacy_monitor_peers: null,
      enabled_at: policy.migration.enabled_at, reason: policy.migration.reason,
      warning: '移行用 legacy-monitor が有効です。登録済み拠点は共有鍵で health/node の監視だけ可能で、なりすまし耐性がありません。更新・配備・秘密配布は拒否されます。Cr 認証の配備後に無効化してください',
    };
  }
  const legacy = Object.entries(policy.config.peers).filter(([, peer]) => peer.mode === 'legacy-monitor').map(([id]) => id);
  return {
    mode: 'cr-v1', legacy_monitor_peers: legacy, enabled_at: null, reason: null,
    warning: legacy.length > 0
      ? `${legacy.length} 拠点が legacy-monitor (共有鍵・監視のみ) のままです。cr-v1 へ移行してください`
      : null,
  };
}
