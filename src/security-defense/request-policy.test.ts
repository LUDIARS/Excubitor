import { describe, it, expect } from 'vitest';
import { RequestPolicy } from './request-policy.js';
import { defenseConfigSchema } from './config.js';
import { event } from '../intrusion/test-fixtures.js';
import { RequestFilter } from '../intrusion/request-filter.js';
import { config as ingressConfig } from '../intrusion/test-fixtures.js';

const rule = { service: event.service, requestsPerMinute: 600, authFailuresPerMinute: 2, authPaths: ['/login'] };
describe('service request defenses', () => {
  it('does not block normal browser volume in observation mode or leak one service counter into another', () => {
    const policy = new RequestPolicy(defenseConfigSchema.parse({ services: [rule, { ...rule, service: 'other' }] }));
    for (let i = 0; i < 473; i++) expect(policy.inspect({ ...event, at: 1000 + i })).toBeNull();
    for (let i = 0; i < 200; i++) policy.inspect({ ...event, at: 2000 + i });
    expect(policy.inspect({ ...event, at: 3000 })?.action).toBe('observe');
    expect(policy.inspect({ ...event, service: 'other', at: 3000 })).toBeNull();
  });
  it('requires a configured auth route and gives temporary restrictions an expiry', () => {
    const policy = new RequestPolicy(defenseConfigSchema.parse({ mode: 'enforce', blockSeconds: 10, services: [rule] }));
    for (let i = 0; i < 30; i++) expect(policy.response({ ...event, path: '/assets', at: 1000 }, 403)).toBeNull();
    policy.response({ ...event, path: '/login', at: 1000 }, 401);
    expect(policy.response({ ...event, path: '/login', at: 2000 }, 401)?.reason).toBe('authentication_burst');
    expect(policy.inspect({ ...event, at: 2001 })?.action).toBe('deny');
    expect(policy.inspect({ ...event, at: 12001 })).toBeNull();
  });
  it('never labels HTTP success as a successful authentication', () => {
    const policy = new RequestPolicy(defenseConfigSchema.parse({ services: [rule] }));
    expect(policy.response({ ...event, path: '/login' }, 200)).toBeNull();
  });
  it('preserves exploit blocking even when a service has an observation policy', async () => {
    const filter = new RequestFilter(ingressConfig, { policy: new RequestPolicy(defenseConfigSchema.parse({ services: [rule] })),
      evidence: () => {}, notifyDenied: async () => {}, warn: () => {}, now: () => 1000 });
    expect(filter.inspect({ ...event, path: '/.env' })).toBe(false);
    expect(filter.inspect(event)).toBe(true);
    await filter.stop();
  });
});
