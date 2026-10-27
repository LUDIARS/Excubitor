import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { IntrusionStore } from './store.js';

describe('durable crash latch', () => {
  it('retains the running marker across reopening even when no incident was saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-intrusion-'));
    try {
      const first = new IntrusionStore(join(dir, 'state.sqlite'));
      expect(first.wasRunning()).toBe(false);
      first.markRunning(true);
      first.close();
      const second = new IntrusionStore(join(dir, 'state.sqlite'));
      try {
        expect(second.wasRunning()).toBe(true);
        expect(second.read()).toBeNull();
      } finally { second.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
