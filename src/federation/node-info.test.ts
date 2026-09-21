import { describe, expect, it } from 'vitest';
import { buildNodeInfo } from './node-info.js';
import type { ServiceCoverage } from './coverage.js';

const coverage: ServiceCoverage[] = [
  { code: 'a', name: 'A', project_code: null, kind: 'managed', covered: true, source: 'catalog' },
  { code: 'b', name: 'B', project_code: null, kind: 'observed', covered: true, source: 'catalog' },
  { code: 'c', name: 'C', project_code: null, kind: 'managed', covered: false, source: 'override' },
];

describe('buildNodeInfo', () => {
  it('summarizes version, platform, listener, peers and coverage for other sites to read', () => {
    const info = buildNodeInfo({
      node: 'win',
      version: '1.4.0',
      git: { branch: 'main', hash: 'abcdef123456' },
      startedAt: 1_000,
      platform: { os: 'win32', release: '10.0.26100', arch: 'x64', hostname: 'DESKTOP', node_version: 'v24.14.1' },
      listener: { enabled: true, listening: ['100.64.0.1:17335'], error: null },
      peers: { registered: 2, enabled: 1 },
      coverage,
      catalogTotal: 4,
      updateSource: 'mesh',
    });
    expect(info).toEqual({
      node: 'win',
      excubitor: { version: '1.4.0', git_branch: 'main', git_hash: 'abcdef123456', started_at: 1_000 },
      platform: { os: 'win32', release: '10.0.26100', arch: 'x64', hostname: 'DESKTOP', node_version: 'v24.14.1' },
      listener: { enabled: true, listening: ['100.64.0.1:17335'], error: null },
      peers: { registered: 2, enabled: 1 },
      services: { catalog_total: 4, covered: 2, managed: 1 },
      update_source: 'mesh',
    });
  });
});
