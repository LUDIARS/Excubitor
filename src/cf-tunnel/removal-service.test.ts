import { describe, expect, it } from 'vitest';
import { assertTunnelDeletable, planTunnelCnameRemoval } from './removal-service.js';
import { RouteRejectedError } from './route-service.js';
import type { CfDnsRecord } from './cloudflare-dns-api.js';

const TARGET = 'tid.cfargotunnel.com';
const record = (r: Partial<CfDnsRecord>): CfDnsRecord => ({ id: 'r1', type: 'CNAME', name: 'a.example.com', content: TARGET, proxied: true, ...r });

describe('planTunnelCnameRemoval', () => {
  it('tunnel を向いた CNAME だけを消す (大文字小文字は無視)', () => {
    expect(planTunnelCnameRemoval([record({ id: 'ours', content: 'TID.cfargotunnel.com' })], TARGET)).toEqual({ kind: 'delete', recordId: 'ours' });
  });

  it('レコードが無ければ absent (冪等)', () => {
    expect(planTunnelCnameRemoval([], TARGET)).toEqual({ kind: 'absent' });
  });

  it('別の向き先・別種のレコードは消さずに止める', () => {
    expect(() => planTunnelCnameRemoval([record({ content: 'other.cfargotunnel.com' })], TARGET)).toThrow(RouteRejectedError);
    expect(() => planTunnelCnameRemoval([record({ type: 'A', content: '1.2.3.4' })], TARGET)).toThrow(/向いていない/);
  });
});

describe('assertTunnelDeletable', () => {
  const tunnel = { id: 'tid', name: 'ludiars-local', status: 'inactive' };
  const catchAll = [{ service: 'http_status:404' }];

  it('名前一致・ルート 0 件・未接続なら通す', () => {
    expect(() => assertTunnelDeletable(tunnel, catchAll, 'ludiars-local')).not.toThrow();
    expect(() => assertTunnelDeletable({ ...tunnel, status: 'down' }, [], ' ludiars-local ')).not.toThrow();
  });

  it('confirm が tunnel 名と一致しなければ止める', () => {
    expect(() => assertTunnelDeletable(tunnel, catchAll, undefined)).toThrow(/confirm/);
    expect(() => assertTunnelDeletable(tunnel, catchAll, 'tid')).toThrow(/confirm/);
  });

  it('hostname 付きルートが残っていれば止める (allowlist 外の他所のルートを巻き込まない)', () => {
    const ingress = [{ hostname: 'qs.example.com', service: 'http://127.0.0.1:1' }, ...catchAll];
    expect(() => assertTunnelDeletable(tunnel, ingress, 'ludiars-local')).toThrow(/qs\.example\.com/);
  });

  it('cloudflared が接続中なら止める', () => {
    expect(() => assertTunnelDeletable({ ...tunnel, status: 'healthy' }, catchAll, 'ludiars-local')).toThrow(/接続中/);
    expect(() => assertTunnelDeletable({ ...tunnel, status: 'degraded' }, catchAll, 'ludiars-local')).toThrow(RouteRejectedError);
  });
});
