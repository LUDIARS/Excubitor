import { createHash } from 'node:crypto';
import { Client, type ClientChannel } from 'ssh2';
import { TerminalError, type TerminalProfile, type TerminalTarget } from './schema.js';
import { resolveTerminalAddress } from './network-policy.js';
import { resolveCredentials } from './credentials.js';

/** @implements SPEC-TERMINAL-CONNECTIONS */
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; signal: string | null }
const fingerprint = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Host-key discovery never sends credentials and never authorizes a connection. */
export async function inspectHostKey(target: TerminalTarget): Promise<{ address: string; hostKey: string }> {
  const address = await resolveTerminalAddress(target);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let observedKey: string | undefined;
    const finish = (key?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (key ?? observedKey) resolve({ address, hostKey: (key ?? observedKey)! });
      else reject(new TerminalError('host_key_probe_failed'));
    };
    const timer = setTimeout(() => finish(), CONNECT_TIMEOUT_MS);
    client.on('error', () => finish()).on('close', () => finish());
    try {
      client.connect({ host: address, port: target.port, username: 'host-key-probe', readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => { observedKey = fingerprint(key); queueMicrotask(() => finish(observedKey)); return false; } });
    } catch { finish(); }
  });
}

/** One bounded, noninteractive SSH exec channel per request. No local shell, agent or authentication fallback. */
export async function executeTerminalCommand(profile: TerminalProfile, command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const address = await resolveTerminalAddress(profile);
  const credentials = await resolveCredentials(profile);
  if (signal?.aborted) throw new TerminalError('aborted');
  return new Promise((resolve, reject) => {
    const client = new Client();
    let channel: ClientChannel | undefined;
    let settled = false;
    let bytes = 0;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let hostKeyRejected = false;
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      channel?.destroy();
      client.destroy();
      if (error) reject(new TerminalError(error));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal: exitSignal });
    };
    const abort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('command_timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (target: Buffer[], data: Buffer): void => {
      bytes += data.length;
      if (bytes > MAX_OUTPUT_BYTES) finish('output_limit');
      else target.push(Buffer.from(data));
    };
    client.on('error', () => finish(hostKeyRejected ? 'host_key_changed' : 'ssh_connection_failed'));
    client.on('close', () => finish('connection_closed'));
    client.on('ready', () => {
      client.exec(command, { pty: false }, (error, stream) => {
        if (error) { finish('exec_failed'); return; }
        if (settled) { stream.destroy(); return; }
        channel = stream;
        stream.on('data', (data: Buffer) => collect(stdout, data));
        stream.stderr.on('data', (data: Buffer) => collect(stderr, data));
        stream.on('error', () => finish('channel_failed'));
        stream.on('exit', (code: number | null, sig?: string) => { exitCode = code; exitSignal = sig ?? null; });
        stream.on('close', () => finish(exitCode === null && exitSignal === null ? 'exit_status_missing' : undefined));
        stream.end();
      });
    });
    try {
      client.connect({ host: address, port: profile.port, ...credentials,
        readyTimeout: Math.min(CONNECT_TIMEOUT_MS, timeoutMs),
        authHandler: [profile.auth === 'password' ? 'password' : 'publickey'],
        hostVerifier: (key: Buffer) => { hostKeyRejected = fingerprint(key) !== profile.hostKey; return !hostKeyRejected; } });
    } catch { finish('ssh_connection_failed'); }
  });
}
