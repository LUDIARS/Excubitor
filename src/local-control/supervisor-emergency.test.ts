import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Catalog, Service } from '../catalog/loader.js';
import { runEmergencyAction } from '../ops/emergency.js';
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalControlRequest,
} from './protocol.js';
import type { LocalControlDispatch } from './server.js';
import { LocalControlStateStore } from './state-store.js';
import { LocalControlSupervisor } from './supervisor.js';

vi.mock('../ops/emergency.js', () => ({
  runEmergencyAction: vi.fn(async (_catalog, service: Service, action: string, prompt?: string, port?: number) => ({
    ok: true,
    action,
    code: service.code,
    port: port ?? service.port ?? null,
    pids: [9876],
    stdout: 'emergency complete',
    stderr: '',
    ...(prompt ? { prompt } : {}),
  })),
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LocalControlSupervisor emergency operations', () => {
  it('executes emergency actions inside the service target control plane', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-emergency-test-'));
    temporaryDirectories.push(rootDir);
    const service = {
      code: 'emergency-service',
      name: 'Emergency service',
      runtime: 'node',
      port: 32123,
      disabled: false,
    } as Service;
    const catalog = { services: [service] } as Catalog;
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      resolveCatalogReady: () => void;
      catalog: { refresh: () => Promise<Catalog>; service: (code: string) => Service | undefined };
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    internals.catalog = {
      refresh: async () => catalog,
      service: (code) => code === service.code ? service : undefined,
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    internals.resolveReady();
    internals.resolveCatalogReady();

    const dispatch = await internals.dispatch({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'emergency-operation',
      target: { kind: 'service', code: service.code },
      action: 'kill-port',
      actor: 'test',
      dispatch: 'execute',
      parameters: { port: 32124 },
    });

    expect(dispatch.response).toMatchObject({
      ok: true,
      state: 'completed',
      payload: { kind: 'emergency-result', value: { action: 'kill-port', port: 32124 } },
    });
    expect(runEmergencyAction).toHaveBeenCalledWith(
      catalog,
      service,
      'kill-port',
      undefined,
      32124,
    );
  });
});
