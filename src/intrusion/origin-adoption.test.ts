import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CfTunnelConfig } from '../cf-tunnel/cloudflare-api.js';
import { intrusionConfigSchema } from './config.js';
import { config } from './test-fixtures.js';
import { publicRuleHash, verifyExistingOrigins } from './origin-adoption.js';
import { OriginApprovals } from './origin-approvals.js';
import { planGatewayRoutes } from './route-plan.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(management = false) {
  const directory = mkdtempSync(join(tmpdir(), 'ex-origin-adoption-'));
  directories.push(directory);
  const file = join(directory, 'approvals.json');
  const source: CfTunnelConfig = { ingress: [{ hostname: 'app.example.com', path: '^/allowed/',
    service: 'http://localhost:8080', originRequest: { access: { required: true, audTag: ['aud'], teamName: 'team' } } },
  { service: 'http_status:404' }] };
  const routeKey = 'r-approved.intrusion.invalid';
  const policy = intrusionConfigSchema.parse({ ...config, routes: [{ ...config.routes[0], path: '^/allowed/', routeKey,
    adoptExisting: { tunnelId: config.tunnels[0]!.id, sourceHash: publicRuleHash(source.ingress![0]!, source) } }] });
  let current = source;
  const api = { getConfiguration: vi.fn(async () => current), putConfiguration: vi.fn() };
  const keys = new Set(management ? [routeKey] : []);
  const verify = () => verifyExistingOrigins(api, policy, 9000, new OriginApprovals(file), keys);
  return { source, policy, api, verify, file, setCurrent: (value: CfTunnelConfig) => { current = value; } };
}

describe('existing public origin provenance', () => {
  it('does not create approval during read-only coverage verification', async () => {
    const f = fixture();
    await expect(verifyExistingOrigins(f.api, f.policy, 9000, new OriginApprovals(f.file), new Set(), false)).rejects.toThrow('missing');
    expect(new OriginApprovals(f.file).get(`${config.tunnels[0]!.id}/${f.policy.routes[0]!.routeKey}`)).toBeUndefined();
  });
  it('persists approval and survives gateway migration and blocked-route recovery without writes to CF', async () => {
    const f = fixture(true);
    await f.verify();
    const migrated = planGatewayRoutes(f.source, f.policy, config.tunnels[0]!.id, 9000);
    f.setCurrent(migrated);
    await f.verify();
    f.setCurrent({ ...migrated, ingress: migrated.ingress!.map(rule => rule.hostname ? { ...rule, service: 'http_status:503' } : rule) });
    await f.verify();
    expect(f.api.putConfiguration).not.toHaveBeenCalled();
  });
  it('rejects adopted gateway state without durable original proof', async () => {
    const f = fixture();
    f.setCurrent(planGatewayRoutes(f.source, f.policy, config.tunnels[0]!.id, 9000));
    await expect(f.verify()).rejects.toThrow('source proof');
  });
  it('rejects a changed configured origin after initial approval', async () => {
    const f = fixture();
    await f.verify();
    f.policy.routes[0]!.origin = 'http://127.0.0.1:8081';
    await expect(f.verify()).rejects.toThrow('changed');
  });
  it('rejects weakened Access after gateway migration', async () => {
    const f = fixture(true);
    await f.verify();
    const migrated = planGatewayRoutes(f.source, f.policy, config.tunnels[0]!.id, 9000);
    migrated.ingress![0]!.originRequest = { httpHostHeader: f.policy.routes[0]!.routeKey, access: { required: false } };
    f.setCurrent(migrated);
    await expect(f.verify()).rejects.toThrow('changed');
  });
  it('requires validated Access for management even when the source hash matches', async () => {
    const f = fixture(true);
    f.source.ingress![0]!.originRequest = {};
    f.policy.routes[0]!.adoptExisting!.sourceHash = publicRuleHash(f.source.ingress![0]!, f.source);
    await expect(f.verify()).rejects.toThrow('Access');
  });
  it('rejects mismatched source origin and corrupt receipt', async () => {
    const f = fixture();
    f.policy.routes[0]!.origin = 'http://127.0.0.1:8081';
    await expect(f.verify()).rejects.toThrow('origin inventory changed');
    writeFileSync(f.file, 'invalid-json', 'utf8');
    await expect(f.verify()).rejects.toThrow();
  });
  it('requires adoption for exact CloudFront HTTPS origins and rejects other public destinations', () => {
    const f = fixture();
    const route = { ...f.policy.routes[0]!, origin: 'https://distribution.cloudfront.net' };
    expect(intrusionConfigSchema.safeParse({ ...f.policy, routes: [route] }).success).toBe(true);
    expect(intrusionConfigSchema.safeParse({ ...f.policy, routes: [{ ...route, adoptExisting: undefined }] }).success).toBe(false);
    expect(intrusionConfigSchema.safeParse({ ...f.policy, routes: [{ ...route, origin: 'https://cloudfront.net.evil.test' }] }).success).toBe(false);
  });
});
