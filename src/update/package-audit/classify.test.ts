import { describe, expect, it } from 'vitest';

import {
  globalSemverImpact,
  isBreakingVersionChange,
  localSemverImpact,
  updateCategory,
} from './classify.js';

describe('package update classification', () => {
  it('uses npm wanted/latest to separate range-safe and breaking local updates', () => {
    expect(localSemverImpact({ current: '1.2.0', wanted: '1.4.0', latest: '1.4.0' })).toBe('safe');
    expect(localSemverImpact({ current: '1.2.0', wanted: '1.4.0', latest: '2.0.0' })).toBe('breaking');
  });

  it('treats 0.x minor boundaries and unknown versions as breaking for global CLIs', () => {
    expect(isBreakingVersionChange('0.1.4', '0.2.0')).toBe(true);
    expect(globalSemverImpact({ current: '1.2.0', latest: '1.3.0' })).toBe('safe');
    expect(globalSemverImpact({ current: 'linked', latest: '1.3.0' })).toBe('breaking');
  });

  it('prioritizes native rebuild classification over semver impact', () => {
    expect(updateCategory('safe', true)).toBe('native');
    expect(updateCategory('breaking', false)).toBe('major');
  });
});
