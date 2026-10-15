import { describe, expect, it } from 'vitest';
import { bootstrapHookEnv, resolveExcubitorPort } from './hook-env.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
describe('service-owned script env', () => {
  it('gives the script the loopback Excubitor endpoint when the backend env has none', () => {
    const env = bootstrapHookEnv({ PATH: '/bin' }, '/cfg/agent-token');
    expect(env.EXCUBITOR_URL).toBe('http://127.0.0.1:17332');
    expect(env.EXCUBITOR_PORT).toBe('17332');
    expect(env.EXCUBITOR_AGENT_TOKEN_PATH).toBe('/cfg/agent-token');
    expect(env.PATH).toBe('/bin');
  });

  it('follows the configured backend port', () => {
    const env = bootstrapHookEnv({ EXCUBITOR_PORT: '18000' }, '/cfg/agent-token');
    expect(env.EXCUBITOR_URL).toBe('http://127.0.0.1:18000');
    expect(env.EXCUBITOR_PORT).toBe('18000');
  });

  it('keeps an explicitly configured agent token path', () => {
    const env = bootstrapHookEnv({ EXCUBITOR_AGENT_TOKEN_PATH: '/custom/token' }, '/cfg/agent-token');
    expect(env.EXCUBITOR_AGENT_TOKEN_PATH).toBe('/custom/token');
  });

  it('rejects an invalid port instead of silently falling back', () => {
    expect(() => resolveExcubitorPort('abc')).toThrow('invalid EXCUBITOR_PORT');
    expect(() => resolveExcubitorPort('70000')).toThrow('invalid EXCUBITOR_PORT');
    expect(resolveExcubitorPort(undefined)).toBe(17332);
  });
});
