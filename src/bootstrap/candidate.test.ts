import { describe, expect, it } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { isServerInstallCandidate } from './candidate.js';

/** @implements SPEC-SERVICE-INSTALL-CANDIDATES */
const service = (values: Partial<Service>): Service => ({ code: 'actio', runtime: 'node', disabled: false, tier: 'personal', ...values } as Service);
describe('server installation classification', () => {
  it('keeps personal API services, independently of health', () => {
    expect(isServerInstallCandidate(service({}))).toBe(true);
    expect(isServerInstallCandidate(service({ code: 'actio-web' }))).toBe(true);
    expect(isServerInstallCandidate(service({ code: 'tabula' }))).toBe(true);
    expect(isServerInstallCandidate(service({ code: 'memoria-server' }))).toBe(false);
    expect(isServerInstallCandidate(service({ code: 'memoria-tabula' }))).toBe(false);
    expect(isServerInstallCandidate(service({ code: 'concordia' }))).toBe(false);
    expect(isServerInstallCandidate(service({ code: 'aedilis', tier: 'saas' }))).toBe(true);
  });
  it('excludes native apps, local development tools, games and self install', () => {
    for (const entry of [{ runtime: 'app' }, { runtime: 'android' }, { tier: 'local-app' }, { code: 'example-web', tier: 'saas' }, { code: 'ludellus-server', tier: 'saas' }, { code: 'pagus' }, { code: 'excubitor' }] as Partial<Service>[]) {
      expect(isServerInstallCandidate(service(entry))).toBe(false);
    }
  });
});
