import { expect, it } from 'vitest';
import { verifyArtifactDigest } from './artifact.js';

it('accepts only the independently approved bundle digest', () => {
  const actual = 'a'.repeat(64);
  expect(verifyArtifactDigest({ actual, expected: actual })).toBe(true);
  expect(verifyArtifactDigest({ actual, expected: undefined })).toBe(false);
  expect(verifyArtifactDigest({ actual, expected: 'b'.repeat(64) })).toBe(false);
  expect(verifyArtifactDigest({ actual: '*', expected: '*' })).toBe(false);
});
