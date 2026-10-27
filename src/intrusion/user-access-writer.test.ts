import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { UserAccessLog } from './user-access-log.js';
import { userAccessWriter } from './user-access-writer.js';
import { accessEvidenceWriter } from './evidence-log.js';

describe('separate user and security streams', () => {
  it('keeps all security evidence and only one visit per service in distinct files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ex-user-access-'));
    try {
      const log = new UserAccessLog(userAccessWriter(root), vi.fn());
      const security = accessEvidenceWriter(root);
      const event = { at: Date.UTC(2026, 9, 28), service: 'one', hostname: 'one.example.com',
        country: 'JP', clientIp: '192.0.2.1', method: 'GET', path: '/?secret=never-log' };
      for (const service of ['one', 'one', 'two']) {
        const access = { ...event, service };
        security(access, 200);
        log.record(access, { cf_ray: '0123456789abcdef-NRT', user_agent: 'Phone', accept_language: 'ja' });
      }
      const read = (stream: string): string[] => readFileSync(join(root, stream, '2026-10-28.jsonl'), 'utf8').trim().split('\n');
      expect(read('excubitor-intrusion')).toHaveLength(3);
      for (const service of ['one', 'two']) {
        const lines = read(`excubitor-user-access-${service}`);
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!).ctx.service).toBe(service);
        expect(lines[0]).not.toContain('never-log');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
