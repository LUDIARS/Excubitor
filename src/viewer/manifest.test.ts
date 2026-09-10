import { describe, expect, it } from 'vitest';
import { parseViewerManifest } from './manifest.js';

const manifest = {
  version: 1, expiresAt: 2_000,
  entries: [{ code: 'example', name: 'Example', href: '/viewer/apps/example/', excludedReason: null }],
  targets: [{ code: 'example', prefix: '/viewer/apps/example', upstream: 'http://127.0.0.1:9000/', origins: {} }],
};

describe('DMZ directory boundary', () => {
  it('rejects expired publication instead of reusing a stale target', () => {
    expect(() => parseViewerManifest(JSON.stringify(manifest), 2_000)).toThrow('expired');
  });

  it('rejects accidental management data in the public document', () => {
    expect(() => parseViewerManifest(JSON.stringify({ ...manifest, env: { SECRET: 'example' } }), 1_000)).toThrow();
  });

  it('rejects a remote upstream and namespace mismatch', () => {
    for (const change of [{ upstream: 'http://example.com:9000/' }, { prefix: '/api/v1/config' }]) {
      const value = { ...manifest, targets: [{ ...manifest.targets[0], ...change }] };
      expect(() => parseViewerManifest(JSON.stringify(value), 1_000)).toThrow();
    }
  });

  it('rejects entries that normalize outside their published namespace', () => {
    const entries = [{ ...manifest.entries[0], href: '/viewer/apps/example/../../assets/private.js' }];
    expect(() => parseViewerManifest(JSON.stringify({ ...manifest, entries }), 1_000)).toThrow('entry');
  });

  it('rejects duplicate entries and targets that are not published in the directory', () => {
    expect(() => parseViewerManifest(JSON.stringify({
      ...manifest, entries: [...manifest.entries, manifest.entries[0]],
    }), 1_000)).toThrow('entry');
    expect(() => parseViewerManifest(JSON.stringify({ ...manifest, entries: [] }), 1_000))
      .toThrow('Unpublished');
  });

  it('restricts origin rewrites to published loopback services', () => {
    const validTargets = [{ ...manifest.targets[0], origins: {
      'http://localhost:9000': '/viewer/apps/example',
      'ws://[::1]:9000': '/viewer/apps/example',
    } }];
    expect(parseViewerManifest(JSON.stringify({ ...manifest, targets: validTargets }), 1_000).targets)
      .toEqual(validTargets);
    for (const origins of [
      { 'https://example.com': '/viewer/apps/example' },
      { 'http://127.0.0.1:9001': '/viewer/apps/unpublished' },
    ]) {
      const targets = [{ ...manifest.targets[0], origins }];
      expect(() => parseViewerManifest(JSON.stringify({ ...manifest, targets }), 1_000)).toThrow('origin');
    }
  });
});
