import { describe, it, expect, beforeAll } from 'vitest';
import { filterKeys } from './resolve.js';

describe('filterKeys', () => {
  const env = { NOTION_TOKEN: 't', NOTION_DATABASE_ID: 'db', OTHER: 'x' };

  it('returns all when keys omitted', () => {
    expect(filterKeys(env)).toEqual(env);
  });
  it('returns all when keys empty', () => {
    expect(filterKeys(env, [])).toEqual(env);
  });
  it('keeps only requested keys', () => {
    expect(filterKeys(env, ['NOTION_TOKEN', 'NOTION_DATABASE_ID'])).toEqual({
      NOTION_TOKEN: 't',
      NOTION_DATABASE_ID: 'db',
    });
  });
  it('ignores requested keys that are absent', () => {
    expect(filterKeys(env, ['MISSING'])).toEqual({});
  });
});

describe('verifyAgentToken', () => {
  beforeAll(() => {
    process.env.EXCUBITOR_AGENT_TOKEN = 'test-token-abc';
  });

  it('accepts the correct token (bearer + raw)', async () => {
    const { verifyAgentToken } = await import('./agent-token.js');
    expect(verifyAgentToken('Bearer test-token-abc')).toBe(true);
    expect(verifyAgentToken('test-token-abc')).toBe(true);
  });
  it('rejects wrong / missing token', async () => {
    const { verifyAgentToken } = await import('./agent-token.js');
    expect(verifyAgentToken('Bearer nope')).toBe(false);
    expect(verifyAgentToken('')).toBe(false);
    expect(verifyAgentToken(undefined)).toBe(false);
  });
});
