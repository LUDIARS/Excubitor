import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReleaseRouter } from './router.js';
import { buildRelease } from './orchestrator.js';

vi.mock('./manifest.js', () => ({
  listReleaseManifests: () => [{ name: 'demo', path: 'demo.yaml' }],
  loadReleaseManifest: () => ({ name: 'demo' }),
}));
vi.mock('./orchestrator.js', () => ({ buildRelease: vi.fn() }));

describe('release build body validation', () => {
  beforeEach(() => { vi.mocked(buildRelease).mockReset(); });
  it.each(["1'", '1;echo', '1 2', '..', '../x', '1/x', '1\\x', '', 'a'.repeat(65), '1\n'])('returns invalid_body for %j', async (version) => {
    const response = await buildReleaseRouter(() => null).request('/api/v1/releases/demo/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(buildRelease).not.toHaveBeenCalled();
  });
  it.each(['0.0.0', '1.2.3', '1.2.3-rc.1+build', 'a'.repeat(64), undefined])('passes valid version %j', async (version) => {
    vi.mocked(buildRelease).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof buildRelease>>);
    const response = await buildReleaseRouter(() => null).request('/api/v1/releases/demo/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
    });
    expect(response.status).toBe(200);
    expect(buildRelease).toHaveBeenCalledWith({ name: 'demo' }, expect.objectContaining({ catalog: null }));
  });
});
