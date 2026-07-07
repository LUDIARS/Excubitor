import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Service } from '../catalog/loader.js';
import {
  assertHotReloadAllowed,
  detectHotReload,
  detectHotReloadCommand,
} from './hot-reload.js';

describe('hot reload guard', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('detects common dev/watch commands', () => {
    expect(detectHotReloadCommand('npm run dev')).toBe('npm/pnpm/yarn/bun dev');
    expect(detectHotReloadCommand('pnpm run dev:server -- --host 127.0.0.1')).toBe('npm/pnpm/yarn/bun dev');
    expect(detectHotReloadCommand('tsx watch src/server.ts')).toBe('tsx watch');
    expect(detectHotReloadCommand('node --watch dist/index.js')).toBe('node --watch');
  });

  it('does not block non-watch start commands', () => {
    expect(detectHotReloadCommand('npm run start')).toBeNull();
    expect(detectHotReloadCommand('node dist/server.js')).toBeNull();
  });

  it('rejects hot reload by default', async () => {
    await expect(
      assertHotReloadAllowed(service(), { kind: 'command', command: 'npm run dev' }),
    ).rejects.toThrow(/hot reload is disabled/);
  });

  it('allows hot reload only when the service opts in', async () => {
    await expect(
      assertHotReloadAllowed(service({ allow_hot_reload: true }), { kind: 'command', command: 'npm run dev' }),
    ).resolves.toBeUndefined();
  });

  it('inspects start scripts before allowing spawn', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'excubitor-hot-reload-'));
    const script = join(tempDir, 'start-demo.bat');
    writeFileSync(script, '@echo off\r\nnpm run dev:server\r\n', 'utf8');

    const detection = await detectHotReload({ kind: 'start_script', path: script });
    expect(detection).toMatchObject({ source: 'start_script', marker: 'npm/pnpm/yarn/bun dev' });
    await expect(
      assertHotReloadAllowed(service(), { kind: 'start_script', path: script }),
    ).rejects.toThrow(/start_script/);
  });
});

function service(overrides: Partial<Service> = {}): Service {
  return {
    code: 'demo',
    name: 'Demo',
    runtime: 'node',
    cwd: 'E:\\Document\\Ars\\Demo',
    command: 'npm run dev',
    disabled: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'no',
    max_restart: 5,
    required_env: [],
    ...overrides,
  } as unknown as Service;
}
