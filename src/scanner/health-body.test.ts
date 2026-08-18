import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { extractReportedVersion } from './health-body.js';
import { probeServiceHealth } from './health.js';

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

describe('extractReportedVersion', () => {
  it('reads the version a service names in its health body', async () => {
    const res = jsonResponse(JSON.stringify({ ok: true, service: 'glab', version: '0.1.0' }));
    await expect(extractReportedVersion(res)).resolves.toBe('0.1.0');
  });

  it('trims surrounding whitespace', async () => {
    const res = jsonResponse(JSON.stringify({ version: '  0.2.0  ' }));
    await expect(extractReportedVersion(res)).resolves.toBe('0.2.0');
  });

  it('keeps the "unknown" fallback as a reported value', async () => {
    const res = jsonResponse(JSON.stringify({ version: 'unknown' }));
    await expect(extractReportedVersion(res)).resolves.toBe('unknown');
  });

  it('returns null when the body is not JSON', async () => {
    const res = new Response('OK', { headers: { 'content-type': 'text/plain' } });
    await expect(extractReportedVersion(res)).resolves.toBeNull();
    expect(res.bodyUsed).toBe(true);
  });

  it('returns null when the body is JSON but has no version', async () => {
    const res = jsonResponse(JSON.stringify({ ok: true, service: 'concordia' }));
    await expect(extractReportedVersion(res)).resolves.toBeNull();
  });

  it('returns null when version is not a string', async () => {
    const res = jsonResponse(JSON.stringify({ version: 1 }));
    await expect(extractReportedVersion(res)).resolves.toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', async () => {
    const res = jsonResponse('{"version": ');
    await expect(extractReportedVersion(res)).resolves.toBeNull();
  });

  it('gives up on an oversized body rather than buffering it', async () => {
    const res = jsonResponse(JSON.stringify({ version: '1.0.0', pad: 'x'.repeat(32 * 1024) }));
    await expect(extractReportedVersion(res)).resolves.toBeNull();
  });

  it('rejects an absurdly long version string', async () => {
    const res = jsonResponse(JSON.stringify({ version: '1'.repeat(65) }));
    await expect(extractReportedVersion(res)).resolves.toBeNull();
  });

  it('rejects control characters in a reported version', async () => {
    const res = jsonResponse(JSON.stringify({ version: '1.0.0\u0000forged' }));
    await expect(extractReportedVersion(res)).resolves.toBeNull();
  });
});

describe('HTTP health version reporting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the bounded health-body version with a successful probe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(JSON.stringify({
      ok: true,
      service: 'demo',
      version: '1.2.3',
    }))));

    await expect(probeServiceHealth(httpService())).resolves.toMatchObject({
      ok: true,
      reason: 'http',
      reportedVersion: '1.2.3',
    });
  });

  it('discards a version claimed by a failed HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ version: '9.9.9' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )));

    await expect(probeServiceHealth(httpService())).resolves.toMatchObject({
      ok: false,
      reason: 'failed',
      reportedVersion: null,
    });
  });
});

function httpService(): Service {
  return {
    code: 'demo',
    name: 'Demo',
    runtime: 'node',
    disabled: false,
    develop_derived: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'no',
    max_restart: 5,
    required_env: [],
    health: {
      type: 'http',
      url: 'http://127.0.0.1:1234/health',
      args: [],
      interval_sec: 30,
      grace_period_sec: 10,
    },
  } as Service;
}
