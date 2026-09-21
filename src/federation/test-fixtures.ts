/**
 * federation のテスト用 health 応答を組む (テスト専用。 本番コードから import しない)。
 */

import { FEDERATION_HEALTH_SCHEMA, type NodeHealthPayload, type NodeInfo, type NodeServiceHealth } from './health-types.js';

export function serviceHealth(
  code: string,
  overrides: Partial<Omit<NodeServiceHealth, 'health'>> & { health?: Partial<NodeServiceHealth['health']> } = {},
): NodeServiceHealth {
  const { health, ...rest } = overrides;
  return {
    code,
    name: code,
    project_code: null,
    kind: 'managed',
    covered: true,
    source: 'catalog',
    state: 'running',
    port: null,
    git_branch: 'main',
    ...rest,
    health: {
      state: 'up',
      reason: 'http',
      detail: 'HTTP 200',
      checked_at: 1_000,
      reported_version: null,
      ...health,
    },
  };
}

export function nodeInfo(node: string, overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    node,
    excubitor: { version: '1.4.0', git_branch: 'main', git_hash: 'abcdef123456', started_at: 500 },
    platform: { os: 'win32', release: '10.0', arch: 'x64', hostname: node, node_version: 'v24.0.0' },
    listener: { enabled: true, listening: ['100.64.0.1:17335'], error: null },
    peers: { registered: 1, enabled: 1 },
    services: { catalog_total: 0, covered: 0, managed: 0 },
    update_source: 'origin',
    ...overrides,
  };
}

export function healthPayload(node: string, overrides: Partial<NodeHealthPayload> = {}): NodeHealthPayload {
  return {
    schema: FEDERATION_HEALTH_SCHEMA,
    node,
    generated_at: 1_000,
    scan: { started_at: 900, completed_at: 1_000, duration_ms: 100, interval_ms: 60_000 },
    summary: { service: 'excubitor', services_total: 0, up: 0, down: 0, unknown: 0, open_errors: 0 },
    host: null,
    services: [],
    links: [],
    node_info: nodeInfo(node),
    operations: [],
    ...overrides,
  };
}
