import { describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, resolveTerminalAddress } from './network-policy.js';
import { ProfileSchema } from './schema.js';
import { isLocalTerminalRequest } from './request-policy.js';

describe('terminal target boundary', () => {
  it.each(['10.2.3.4', '172.16.0.1', '172.31.255.254', '192.168.1.2', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1', '::ffff:192.168.1.2'])('accepts private address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '127.0.0.1', '169.254.1.2', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('rejects nonprivate address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
  it('rejects mixed DNS answers rather than selecting the private one', async () => {
    await expect(resolveTerminalAddress({ host: 'mixed.example', port: 22, network: 'private', auth: 'password' }, async () => [
      { address: '10.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 },
    ])).rejects.toThrow('not_lan_or_vpn');
  });
  it('returns a pinned numeric address after one resolution', async () => {
    const lookup = vi.fn(async () => [{ address: '100.64.0.10', family: 4 }]);
    expect(await resolveTerminalAddress({ host: 'vpn.example', port: 22, network: 'private', auth: 'password' }, lookup)).toBe('100.64.0.10');
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('forbids external password before DNS or authentication', async () => {
    const lookup = vi.fn();
    await expect(resolveTerminalAddress({ host: 'example.com', port: 22, network: 'external', auth: 'password' }, lookup)).rejects.toThrow('external_requires_key');
    expect(lookup).not.toHaveBeenCalled();
    expect(ProfileSchema.safeParse({ id: '058c04b4-12d4-4c49-a158-0379bb30d3b3', serverName: 'external', host: 'example.com', port: 22,
      network: 'external', auth: 'password', hostKey: `SHA256:${'A'.repeat(43)}` }).success).toBe(false);
  });
  it('keeps the HTTP and MCP terminal surfaces local and same-origin', () => {
    expect(isLocalTerminalRequest('http://127.0.0.1:17332/mcp')).toBe(true);
    expect(isLocalTerminalRequest('http://127.0.0.1:17332/mcp', 'https://evil.example')).toBe(false);
    expect(isLocalTerminalRequest('https://ex.example/mcp', 'https://ex.example')).toBe(false);
    expect(isLocalTerminalRequest('http://localhost:17332/mcp', 'null')).toBe(false);
  });
});
