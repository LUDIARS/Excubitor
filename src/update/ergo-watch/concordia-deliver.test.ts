import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PackageUpdateBatch } from './concordia-batches.js';
import { deliverToConcordia, postPackageUpdates, type PostOutcome } from './concordia-deliver.js';

const batch = (runId: string): PackageUpdateBatch => ({ runId, messages: [{ text: runId, private: false }] });

describe('deliverToConcordia', () => {
  it('sends every batch in order', async () => {
    const seen: string[] = [];
    const result = await deliverToConcordia([batch('a'), batch('b')], async (entry) => {
      seen.push(entry.runId);
      return { kind: 'accepted', delivered: 1, failed: 0, duplicate: false };
    });
    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ sent: 2, dropped: 0, unsent: [], error: null });
  });

  it('keeps the failing batch and the rest with their runId', async () => {
    const outcomes: PostOutcome[] = [
      { kind: 'accepted', delivered: 1, failed: 0, duplicate: false },
      { kind: 'retry', error: 'concordia HTTP 503 not_configured' },
    ];
    const result = await deliverToConcordia([batch('a'), batch('b'), batch('c')], async () => outcomes.shift()!);
    expect(result.unsent.map((entry) => entry.runId)).toEqual(['b', 'c']);
    expect(result.error).toContain('503');
  });

  it('keeps a batch Concordia only partly posted', async () => {
    const result = await deliverToConcordia([batch('a')], async () => ({
      kind: 'accepted', delivered: 0, failed: 1, duplicate: false,
    }));
    expect(result.unsent.map((entry) => entry.runId)).toEqual(['a']);
  });

  it('drops a batch Concordia rejects as malformed and goes on', async () => {
    const outcomes: PostOutcome[] = [
      { kind: 'rejected', error: 'concordia rejected the batch (HTTP 400)' },
      { kind: 'accepted', delivered: 1, failed: 0, duplicate: false },
    ];
    const result = await deliverToConcordia([batch('a'), batch('b')], async () => outcomes.shift()!);
    expect(result).toMatchObject({ sent: 1, dropped: 1, unsent: [] });
  });
});

describe('postPackageUpdates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts to the package-updates endpoint with the shared token', async () => {
    vi.stubEnv('EXCUBITOR_CONCORDIA_URL', 'http://127.0.0.1:9');
    vi.stubEnv('EXCUBITOR_CONCORDIA_DISPATCH_TOKEN', 'shared');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ delivered: 1, failed: [], duplicate: false }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postPackageUpdates(batch('a'))).resolves.toEqual({
      kind: 'accepted', delivered: 1, failed: 0, duplicate: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9/v1/events/package-updates',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-excubitor-token': 'shared' }),
        body: JSON.stringify({ source: 'ergo-watch', runId: 'a', messages: [{ text: 'a', private: false }] }),
      }),
    );
  });

  it('retries when the channel is not configured and drops a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not_configured' }), { status: 503 })));
    await expect(postPackageUpdates(batch('a'))).resolves.toEqual({ kind: 'retry', error: 'concordia HTTP 503 not_configured' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    await expect(postPackageUpdates(batch('a'))).resolves.toMatchObject({ kind: 'rejected' });
  });

  it('retries when Concordia is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(postPackageUpdates(batch('a'))).resolves.toMatchObject({ kind: 'retry' });
  });
});
