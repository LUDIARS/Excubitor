import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { localBrowserGuard } from '../security/local-browser-guard.js';
import { SecurityReportStore } from './store.js';
import { buildSecurityReportsRouter } from './router.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sample = () => {
  const section = { status: 'unverified' as const, summary: '外部照会未実施', details: 'No safety claim.' };
  return { observedAt: '2026-10-25T00:00:00.000Z', author: 'reviewer', scope: 'Local snapshot',
    dependencies: section, communications: section, vulnerabilities: section, coverage: section };
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ex-security-report-')); dirs.push(dir);
  const store = new SecurityReportStore(dir);
  const app = new Hono();
  app.use('/api/*', localBrowserGuard());
  app.route('/', buildSecurityReportsRouter(code => code === 'svc', store));
  return { app, store, dir };
}
const url = 'http://localhost/api/v1/services/svc/security-report';
describe('service security report records', () => {
  it('keeps incomplete evidence incomplete across a fresh store instance', async () => {
    const { app, dir } = fixture();
    const response = await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sample()) });
    expect(response.status).toBe(201);
    const report = new SecurityReportStore(dir).latest('svc');
    expect(report?.vulnerabilities.status).toBe('unverified');
    expect(report?.service).toBe('svc');
    expect((await app.request(url)).headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not invent reports and rejects unknown service, invalid body and cross-origin writes', async () => {
    const { app, store } = fixture();
    expect(await (await app.request(url)).json()).toEqual({ report: null });
    expect((await app.request(url.replace('/svc/', '/other/'))).status).toBe(404);
    expect(() => store.latest('../outside')).toThrow();
    expect((await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' }, body: JSON.stringify(sample()) })).status).toBe(403);
  });
});
