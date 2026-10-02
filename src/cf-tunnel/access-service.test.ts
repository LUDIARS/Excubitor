import { describe, expect, it } from 'vitest';
import type { CfAccessApp } from './cloudflare-access-api.js';
import {
  accessIdentity,
  accessOriginRequest,
  assertAppName,
  findAppForHostname,
  planTunnelCname,
  requireAllowPolicy,
  withCloudflareAccess,
  withoutCloudflareAccess,
  zoneCandidates,
} from './access-service.js';
import { addRoute, RouteRejectedError } from './route-service.js';

const AUD = 'a'.repeat(64);
const app = (domain: string): CfAccessApp => ({ id: 'app-1', name: 'kintai', domain, aud: AUD, type: 'self_hosted' });

describe('findAppForHostname', () => {
  it('domain の完全一致 (大小無視) だけを返す', () => {
    const apps = [app('br.example.com'), app('Kintai.Example.com')];
    expect(findAppForHostname(apps, 'kintai.example.com')?.domain).toBe('Kintai.Example.com');
    expect(findAppForHostname(apps, 'x.kintai.example.com')).toBeNull();
  });
});

describe('requireAllowPolicy', () => {
  const policies = [
    { id: 'p-allow', name: 'ALLOW ME', decision: 'allow' },
    { id: 'p-deny', name: 'BLOCK', decision: 'deny' },
  ];
  it('既存の Allow ポリシーを返す', () => {
    expect(requireAllowPolicy(policies, 'p-allow').name).toBe('ALLOW ME');
  });
  it('未知・Allow 以外は入力拒否', () => {
    expect(() => requireAllowPolicy(policies, 'nope')).toThrow(RouteRejectedError);
    expect(() => requireAllowPolicy(policies, 'p-deny')).toThrow(RouteRejectedError);
  });
});

describe('assertAppName', () => {
  it('英数字始まりの短い名前だけ通す', () => {
    expect(assertAppName(' kintai ')).toBe('kintai');
    expect(() => assertAppName('<script>')).toThrow(RouteRejectedError);
  });
});

describe('accessIdentity / runtime-config / originRequest', () => {
  it('team と AUD を検証して組む', () => {
    const identity = accessIdentity('Team.cloudflareaccess.com', app('k.example.com'));
    expect(identity).toEqual({ teamDomain: 'team.cloudflareaccess.com', teamName: 'team', audience: AUD });
    expect(accessOriginRequest(identity)).toEqual({ access: { required: true, teamName: 'team', audTag: [AUD] } });
  });
  it('形式が違えば止める', () => {
    expect(() => accessIdentity('example.com', app('k.example.com'))).toThrow();
    expect(() => accessIdentity('team.cloudflareaccess.com', { ...app('k.example.com'), aud: '' })).toThrow();
  });
  it('runtime-config の他のキーは残す', () => {
    const identity = accessIdentity('team.cloudflareaccess.com', app('k.example.com'));
    expect(withCloudflareAccess({ other: 1, cloudflareAccess: { teamDomain: 'old', audience: 'old' } }, identity)).toEqual({
      other: 1,
      cloudflareAccess: { teamDomain: 'team.cloudflareaccess.com', audience: AUD },
    });
    expect(withCloudflareAccess(null, identity)).toEqual({ cloudflareAccess: { teamDomain: 'team.cloudflareaccess.com', audience: AUD } });
  });
});

describe('withoutCloudflareAccess', () => {
  it('cloudflareAccess だけを外し、他のキーは残す', () => {
    expect(withoutCloudflareAccess({ other: 1, cloudflareAccess: { teamDomain: 't', audience: AUD } })).toEqual({ other: 1 });
  });
  it('何も残らなければ null (runtime-config ごと削除)', () => {
    expect(withoutCloudflareAccess({ cloudflareAccess: { teamDomain: 't', audience: AUD } })).toBeNull();
    expect(withoutCloudflareAccess({})).toBeNull();
    expect(withoutCloudflareAccess(null)).toBeNull();
  });
});

describe('zoneCandidates', () => {
  it('親ドメインを長い順に (TLD 単独は含めない)', () => {
    expect(zoneCandidates('kintai.ai-run-do.com')).toEqual(['ai-run-do.com']);
    expect(zoneCandidates('a.b.example.co.jp')).toEqual(['b.example.co.jp', 'example.co.jp', 'co.jp']);
  });
});

describe('planTunnelCname', () => {
  const target = 'tid.cfargotunnel.com';
  const rec = (type: string, content: string, proxied = true) => ({ id: 'r', type, name: 'k.example.com', content, proxied });
  it('レコードが無ければ作る', () => {
    expect(planTunnelCname([], target)).toEqual({ kind: 'create' });
  });
  it('同じ向き先の proxied CNAME があれば何もしない', () => {
    expect(planTunnelCname([rec('CNAME', target)], target)).toEqual({ kind: 'exists' });
  });
  it('別の向き先・別種・非 proxied は上書きしない', () => {
    expect(() => planTunnelCname([rec('CNAME', 'other.example.com')], target)).toThrow(RouteRejectedError);
    expect(() => planTunnelCname([rec('A', '1.2.3.4')], target)).toThrow(RouteRejectedError);
    expect(() => planTunnelCname([rec('CNAME', target, false)], target)).toThrow(RouteRejectedError);
  });
});

describe('addRoute with originRequest', () => {
  it('Access 必須の originRequest を付けて catch-all の前に入れる', () => {
    const identity = accessIdentity('team.cloudflareaccess.com', app('k.example.com'));
    const ingress = addRoute(
      [{ service: 'http_status:404' }],
      { hostname: 'k.example.com', service: 'http://127.0.0.1:4380', originRequest: accessOriginRequest(identity) },
      ['k.example.com'],
    );
    expect(ingress[0]).toEqual({
      hostname: 'k.example.com',
      service: 'http://127.0.0.1:4380',
      originRequest: { access: { required: true, teamName: 'team', audTag: [AUD] } },
    });
    expect(ingress[1]).toEqual({ service: 'http_status:404' });
  });
});
