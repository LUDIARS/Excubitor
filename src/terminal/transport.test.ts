import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectConfig } from 'ssh2';
import type { TerminalProfile } from './schema.js';

const controls = vi.hoisted(() => ({ clients: [] as unknown[], mode: 'ok', key: 'server-key' }));
vi.mock('./credentials.js', () => ({ resolveCredentials: async (p: TerminalProfile) => p.auth === 'password'
  ? { username: 'user', password: 'secret' } : { username: 'user', privateKey: 'private-key' } }));
vi.mock('ssh2', () => ({ Client: class extends EventEmitter {
  config?: ConnectConfig;
  channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), destroy: vi.fn(), end: vi.fn() });
  destroy = vi.fn(() => { this.emit('close'); });
  constructor() { super(); controls.clients.push(this); }
  connect(config: ConnectConfig) {
    this.config = config;
    queueMicrotask(() => {
      const verify = config.hostVerifier as (key: Buffer) => boolean;
      if (!verify(Buffer.from(controls.key))) { this.emit('error', new Error('secret must not escape')); return; }
      this.emit('ready');
    });
  }
  exec(_command: string, _options: unknown, callback: (error: Error | undefined, stream: unknown) => void) {
    callback(undefined, this.channel);
    queueMicrotask(() => {
      if (controls.mode === 'hang') return;
      this.channel.emit('data', Buffer.from(controls.mode === 'large' ? 'x'.repeat(256 * 1024 + 1) : 'output'));
      this.channel.emit('exit', 0);
      this.channel.emit('close');
    });
  }
} }));
import { executeTerminalCommand, inspectHostKey } from './transport.js';

const hostKey = `SHA256:${createHash('sha256').update('server-key').digest('base64').replace(/=+$/, '')}`;
const profile: TerminalProfile = { id: '058c04b4-12d4-4c49-a158-0379bb30d3b3', serverName: 'VPN', host: '100.64.0.10', port: 22, network: 'private', auth: 'password', hostKey };
const client = () => controls.clients[0] as { config: ConnectConfig; destroy: ReturnType<typeof vi.fn>; channel: { destroy: ReturnType<typeof vi.fn> } };
beforeEach(() => { controls.clients = []; controls.mode = 'ok'; controls.key = 'server-key'; });
afterEach(() => { vi.useRealTimers(); });

describe('SSH transport lifecycle', () => {
  it('discovers a fingerprint without sending credentials', async () => {
    expect(await inspectHostKey(profile)).toEqual({ address: profile.host, hostKey });
    expect(client().config.password).toBeUndefined();
    expect(client().config.privateKey).toBeUndefined();
    expect(client().destroy).toHaveBeenCalledOnce();
  });
  it('pins the host, selects only password auth, and closes resources after completion', async () => {
    expect(await executeTerminalCommand(profile, 'hostname', 30000)).toEqual({ stdout: 'output', stderr: '', exitCode: 0, signal: null });
    expect(client().config.host).toBe(profile.host);
    expect(client().config.authHandler).toEqual(['password']);
    expect(client().destroy).toHaveBeenCalledOnce();
    expect(client().channel.destroy).toHaveBeenCalledOnce();
  });
  it('refuses a changed host key and redacts errors', async () => {
    controls.key = 'changed-key';
    await expect(executeTerminalCommand(profile, 'hostname', 30000)).rejects.toThrow('host_key_changed');
    expect(client().destroy).toHaveBeenCalledOnce();
  });
  it('never enables password authentication for an external key profile', async () => {
    await executeTerminalCommand({ ...profile, network: 'external', auth: 'key', host: '8.8.8.8' }, 'hostname', 30000);
    expect(client().config.authHandler).toEqual(['publickey']);
    expect(client().config.password).toBeUndefined();
  });
  it('closes the channel and connection on output overflow', async () => {
    controls.mode = 'large';
    await expect(executeTerminalCommand(profile, 'hostname', 30000)).rejects.toThrow('output_limit');
    expect(client().destroy).toHaveBeenCalledOnce();
    expect(client().channel.destroy).toHaveBeenCalledOnce();
  });
  it('closes resources on request cancellation', async () => {
    controls.mode = 'hang';
    const controller = new AbortController();
    const operation = executeTerminalCommand(profile, 'hostname', 30000, controller.signal);
    const rejection = expect(operation).rejects.toThrow('aborted');
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejection;
    expect(client().destroy).toHaveBeenCalledOnce();
    expect(client().channel.destroy).toHaveBeenCalledOnce();
  });
  it('closes resources when the command deadline expires', async () => {
    vi.useFakeTimers(); controls.mode = 'hang';
    const operation = executeTerminalCommand(profile, 'hostname', 1000);
    const rejection = expect(operation).rejects.toThrow('command_timeout');
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
    expect(client().destroy).toHaveBeenCalledOnce();
    expect(client().channel.destroy).toHaveBeenCalledOnce();
  });
});
