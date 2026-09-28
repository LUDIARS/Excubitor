import { describe, expect, it } from 'vitest';
import { installationBlock } from './install-policy';
import type { MeshCoverageRow, MeshNode } from '../../lib/api';

/**
 * @implements SPEC-SERVICE-BOOTSTRAP
 * @implements SPEC-SERVICE-INSTALL-CANDIDATES
 */
const row: MeshCoverageRow = { code: 'tabula', name: 'Tabula', project_code: 'Tb',
  server_install_candidate: true, repository: 'LUDIARS/Tabula', nodes: [], managed_by: [], issues: [] };
const node: MeshNode = { node: 'remote', peer_id: 'peer-1', is_self: false, status: 'up', stale: false,
  checked_at: 1, last_ok_at: 1, latency_ms: 1, error: null, scan_completed_at: 1,
  services_total: 0, covered_total: 0, covered_down: 0, node_info: null, host: null, operations: [] };
describe('install eligibility', () => {
  it('blocks excluded and unclassified entries even with a valid repository', () => {
    for (const value of [false, null, undefined]) {
      expect(installationBlock({ ...row, server_install_candidate: value }, node)).not.toBeNull();
    }
  });
  it('allows a known repository on a reachable missing-service destination', () => {
    expect(installationBlock(row, node)).toBeNull();
    expect(installationBlock(row, { ...node, is_self: true, peer_id: null })).toBeNull();
  });
  it('allows only the approved external repository', () => {
    expect(installationBlock({ ...row, repository: 'VGA-GLAB/GLAB-Hub' }, node)).toBeNull();
    for (const repository of ['VGA-GLAB/Other', 'other/GLAB-Hub', 'VGA-GLAB/GLAB-Hub/../Other']) {
      expect(installationBlock({ ...row, repository }, node)).not.toBeNull();
    }
  });
  it('blocks old/offline observations and missing remote identity', () => {
    expect(installationBlock(row, { ...node, stale: true })).not.toBeNull();
    expect(installationBlock(row, { ...node, status: 'down' })).not.toBeNull();
    expect(installationBlock(row, { ...node, peer_id: null })).not.toBeNull();
  });
  it('never guesses unknown repositories or installs the supervisor/workspace', () => {
    for (const repository of [null, 'LUDIARS/Excubitor', 'LUDIARS/Castra', 'other/Tabula']) {
      expect(installationBlock({ ...row, repository }, node)).not.toBeNull();
    }
  });
  it('prevents a second request while a matching operation is queued', () => {
    expect(installationBlock(row, { ...node, operations: [{ id: 'op', requested_by: 'self',
      target: { kind: 'service', code: 'tabula' }, action: 'bootstrap', status: 'queued',
      source: 'origin', error: null, last_step: null, created_at: 1, started_at: null, finished_at: null,
    }] })).not.toBeNull();
  });
});
