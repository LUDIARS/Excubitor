import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalProfileStore } from './profile-store.js';
import { buildTerminalRouter } from './router.js';

vi.mock('./transport.js', () => ({ executeTerminalCommand: vi.fn(), inspectHostKey: vi.fn() }));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function router() {
  const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-router-')); directories.push(dir);
  return buildTerminalRouter(new TerminalProfileStore(join(dir, 'profiles.json')));
}
describe('terminal local HTTP boundary', () => {
  it('rejects requests without the custom header, and cross-origin or externally addressed requests', async () => {
    const app = router();
    expect((await app.request('http://127.0.0.1/api/v1/terminal/profiles')).status).toBe(403);
    expect((await app.request('http://127.0.0.1/api/v1/terminal/profiles', { headers: { 'x-excubitor-terminal': '1', origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request('https://public.example/api/v1/terminal/profiles', { headers: { 'x-excubitor-terminal': '1' } })).status).toBe(403);
    const allowed = await app.request('http://127.0.0.1/api/v1/terminal/profiles', { headers: { 'x-excubitor-terminal': '1' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects external password profiles even when the client bypasses the UI', async () => {
    const id = '058c04b4-12d4-4c49-a158-0379bb30d3b3';
    const response = await router().request(`http://127.0.0.1/api/v1/terminal/profiles/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-excubitor-terminal': '1' },
      body: JSON.stringify({ profile: { id, serverName: 'external', host: '8.8.8.8', port: 22, network: 'external', auth: 'password', hostKey: `SHA256:${'A'.repeat(43)}` } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_profile' });
  });
});
