import { describe, it, expect, beforeAll } from 'vitest';
import { sealSecret, openSecret } from './secret-box.js';

// master key を固定して決定的にする (マシン束縛値に依存しない)。
beforeAll(() => {
  process.env.EXCUBITOR_MASTER_KEY = 'test-master-key';
});

describe('secret-box', () => {
  it('seal → open で元に戻る (round-trip)', () => {
    const plain = 'agent-token-abcdef0123456789';
    const sealed = sealSecret(plain);
    expect(sealed).not.toContain(plain); // 平文が混ざらない
    expect(openSecret(sealed)).toBe(plain);
  });

  it('legacy 平文 (非 blob) はそのまま返す (後方互換)', () => {
    expect(openSecret('plain-legacy-token')).toBe('plain-legacy-token');
  });

  it('null は null', () => {
    expect(openSecret(null)).toBeNull();
  });

  it('鍵不一致は null (平文へフォールバックしない)', () => {
    const sealed = sealSecret('secret');
    process.env.EXCUBITOR_MASTER_KEY = 'different-key';
    expect(openSecret(sealed)).toBeNull();
    process.env.EXCUBITOR_MASTER_KEY = 'test-master-key'; // 復帰
  });
});
