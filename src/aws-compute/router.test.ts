import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildAwsComputeRouter } from './router.js';
import { createJournalFixture, fakeSubmit, NOW } from './test-fixtures.js';

let fixture: ReturnType<typeof createJournalFixture>;
beforeEach(() => { fixture = createJournalFixture(); });
afterEach(() => { fixture.db.close(); });

function router(isLoopback = true, configured = true) {
  return buildAwsComputeRouter({
    ...fixture, credentials: { readiness: async () => ({ configured }) }, sweep: { report: () => null },
    allowLaunch: () => true, isLoopback: () => isLoopback, now: () => NOW,
  });
}

const request = (value: unknown) => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});

it('checks the actual socket, loopback host, browser origin and proxy headers', async () => {
  const app = buildAwsComputeRouter({
    ...fixture, credentials: { readiness: async () => ({ configured: true }) }, sweep: { report: () => null },
    allowLaunch: () => true,
  });
  const req = (remoteAddress: string, headers?: Record<string, string>, host = 'localhost:17331') =>
    app.request(`http://${host}/targets`, { headers }, { incoming: { socket: { remoteAddress } } });
  expect((await req('::ffff:127.0.0.1', { origin: 'http://localhost:17331', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  expect((await req('::1')).status).toBe(200);
  expect((await req('192.0.2.1')).status).toBe(403);
  expect((await req('127.0.0.1', { 'x-forwarded-for': '192.0.2.1' })).status).toBe(403);
  expect((await req('127.0.0.1', { origin: 'https://example.test' })).status).toBe(403);
  expect((await req('127.0.0.1', {}, 'ex.example.test')).status).toBe(403);
});

it('returns only the non-secret receipt and reuses the same operation for exact retries', async () => {
  const app = router();
  const initial = await app.request('/jobs', request(fakeSubmit));
  expect(initial.status).toBe(202);
  const receipt = await initial.json() as { operation_id: string };
  expect(receipt).toMatchObject({ job_id: 'job-1', release: 'pending', submission: 'queued', resource_id: null });
  expect(JSON.stringify(receipt)).not.toMatch(/test-revision|fingerprint|inputs/);
  expect(JSON.stringify(receipt)).not.toContain(fixture.journal.get(receipt.operation_id)?.launchToken);
  const duplicate = await app.request('/jobs', request(fakeSubmit));
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual(receipt);
  expect((await app.request('/jobs', request({ ...fakeSubmit, inputs: { REVISION: 'different' } }))).status).toBe(409);
  expect((await app.request(`/jobs/${receipt.operation_id}/cancel`, { method: 'POST' })).status).toBe(202);
  expect(await (await app.request(`/jobs/${receipt.operation_id}`)).json()).toMatchObject({ release: 'requested' });
});

it('rejects non-loopback requests, unregistered keys, missing Vault credentials and expired deadlines', async () => {
  expect((await router(false).request('/jobs', request(fakeSubmit))).status).toBe(403);
  expect((await router(false).request('/targets')).status).toBe(403);
  expect((await router(true, false).request('/jobs', request(fakeSubmit))).status).toBe(503);
  const app = router();
  expect((await app.request('/jobs', request({ ...fakeSubmit, inputs: { COMMAND: 'disallowed' } }))).status).toBe(400);
  expect((await app.request('/jobs', request({ ...fakeSubmit, deadline: new Date(NOW).toISOString() }))).status).toBe(400);
  expect(await (await app.request('/jobs')).json()).toEqual({ jobs: [] });
});
