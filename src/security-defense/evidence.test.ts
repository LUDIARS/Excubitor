import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { accessEvidenceWriter } from '../intrusion/evidence-log.js';
import { event } from '../intrusion/test-fixtures.js';

describe('decision evidence privacy', () => {
  it('records correlation and decision without sensitive paths or raw addresses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-evidence-'));
    try {
      accessEvidenceWriter(dir)({ ...event, path: '/api/reset/secret-token?password=secret',
        requestId: 'test-request', cfRay: '0123456789abcdef-NRT' }, 403,
      { source: 'gateway', action: 'deny', reason: 'exploit_path' });
      const folder = join(dir, 'excubitor-intrusion');
      const text = readFileSync(join(folder, readdirSync(folder)[0]!), 'utf8');
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('password');
      expect(text).not.toContain(event.clientIp);
      expect(JSON.parse(text).ctx).toMatchObject({ reason: 'exploit_path', decision_source: 'gateway', cf_ray: '0123456789abcdef-NRT', route_category: 'api' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
