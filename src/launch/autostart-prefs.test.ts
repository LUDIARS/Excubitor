import { describe, expect, it } from 'vitest';
import { effectiveAutostart } from './autostart-prefs.js';

describe('effectiveAutostart', () => {
  it('prefers the per-site override over the shared catalog value', () => {
    const prefs = new Map([['cernere', true], ['glab', false]]);
    expect(effectiveAutostart({ code: 'cernere', autostart: false }, prefs)).toBe(true);
    expect(effectiveAutostart({ code: 'glab', autostart: true }, prefs)).toBe(false);
  });

  it('falls back to the catalog value, then false', () => {
    expect(effectiveAutostart({ code: 'actio', autostart: true }, new Map())).toBe(true);
    expect(effectiveAutostart({ code: 'actio', autostart: undefined as unknown as boolean }, new Map())).toBe(false);
  });
});
