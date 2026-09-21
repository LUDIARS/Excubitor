/**
 * federation のテスト用 health 応答を組む (テスト専用。 本番コードから import しない)。
 */

import { FEDERATION_HEALTH_SCHEMA, type NodeHealthPayload, type NodeServiceHealth } from './health-types.js';

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
    ...overrides,
  };
}
