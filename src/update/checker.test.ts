import { describe, it, expect } from 'vitest';
import { repoDirOf } from './checker.js';
import type { Service } from '../catalog/loader.js';

function svc(partial: Partial<Service>): Service {
  return {
    code: 'x',
    name: 'X',
    monitor_only: false,
    runtime: 'node',
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    ...partial,
  } as Service;
}

describe('repoDirOf', () => {
  it('node: returns cwd', () => {
    expect(repoDirOf(svc({ runtime: 'node', cwd: 'E:/Document/Ars/Tirocinium' }))).toBe(
      'E:/Document/Ars/Tirocinium',
    );
  });

  it('docker-compose: returns parent dir of compose_file', () => {
    expect(
      repoDirOf(svc({ runtime: 'docker-compose', compose_file: 'E:/Document/Ars/Cernere/docker-compose.yaml' })),
    ).toBe('E:/Document/Ars/Cernere');
  });

  it('returns null when neither cwd nor compose_file', () => {
    expect(repoDirOf(svc({ runtime: 'docker' }))).toBeNull();
  });
});
