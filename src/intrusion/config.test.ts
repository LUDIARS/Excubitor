import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readIntrusionConfig } from './config.js';
import { config } from './test-fixtures.js';

describe('local intrusion opt-in', () => {
  it('is inert only for an absent default, and never ignores invalid or explicitly missing config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ex-intrusion-config-'));
    try {
      const file = join(directory, 'policy.json');
      const missing = join(directory, 'missing.json');
      expect(readIntrusionConfig({}, file)).toBeNull();
      expect(() => readIntrusionConfig({ EXCUBITOR_INTRUSION_CONFIG: missing }, file)).toThrow();
      writeFileSync(file, JSON.stringify(config), 'utf8');
      expect(readIntrusionConfig({}, file)).toEqual(config);
      expect(readIntrusionConfig({ EXCUBITOR_INTRUSION_CONFIG: file }, missing)).toEqual(config);
      writeFileSync(file, '{}', 'utf8');
      expect(() => readIntrusionConfig({}, file)).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
