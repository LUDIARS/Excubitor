import { describe, expect, it } from 'vitest';
import type { Service } from '../../catalog/loader.js';
import { validateOperationRequest } from './validate.js';
import { resolveUpdateSource } from './update-source.js';

const catalog = {
  services: [
    { code: 'svc-a', name: 'A', disabled: false } as Service,
    { code: 'svc-off', name: 'Off', disabled: true } as Service,
  ],
};

describe('validateOperationRequest', () => {
  it('accepts a service request and carries the configured source', () => {
    const result = validateOperationRequest(
      { target: { kind: 'service', code: 'svc-a' }, action: 'deploy' }, catalog, new Map(), 'mesh',
    );
    expect(result).toEqual({ ok: true, request: { target: { kind: 'service', code: 'svc-a' }, action: 'deploy' }, source: 'mesh' });
  });

  it('accepts update / restart / deploy / reflect on Excubitor itself but not stop or start', () => {
    for (const action of ['update', 'restart', 'deploy', 'reflect']) {
      expect(validateOperationRequest({ target: { kind: 'excubitor' }, action }, catalog, new Map(), 'origin').ok).toBe(true);
    }
    for (const action of ['stop', 'start']) {
      expect(validateOperationRequest({ target: { kind: 'excubitor' }, action }, catalog, new Map(), 'origin'))
        .toMatchObject({ ok: false, status: 400, error: 'action_not_allowed_for_target' });
    }
  });

  it('refuses unknown or disabled services and ones this node does not cover', () => {
    expect(validateOperationRequest({ target: { kind: 'service', code: 'nope' }, action: 'restart' }, catalog, new Map(), 'origin'))
      .toMatchObject({ status: 404 });
    expect(validateOperationRequest({ target: { kind: 'service', code: 'svc-off' }, action: 'restart' }, catalog, new Map(), 'origin'))
      .toMatchObject({ status: 404 });
    expect(validateOperationRequest(
      { target: { kind: 'service', code: 'svc-a' }, action: 'restart' }, catalog, new Map([['svc-a', false]]), 'origin',
    )).toMatchObject({ status: 409, error: 'service_not_covered_by_this_node' });
  });

  it('refuses malformed bodies and an unreadable source setting', () => {
    expect(validateOperationRequest({ action: 'restart' }, catalog, new Map(), 'origin')).toMatchObject({ status: 400 });
    expect(validateOperationRequest(
      { target: { kind: 'service', code: 'svc-a' }, action: 'restart' }, catalog, new Map(), null,
    )).toMatchObject({ status: 500, error: 'invalid_update_source_config' });
  });
});

describe('resolveUpdateSource', () => {
  it('defaults to origin, reads mesh, and returns null for anything else', () => {
    expect(resolveUpdateSource({})).toBe('origin');
    expect(resolveUpdateSource({ EXCUBITOR_UPDATE_SOURCE: ' mesh ' })).toBe('mesh');
    expect(resolveUpdateSource({ EXCUBITOR_UPDATE_SOURCE: 'github' })).toBeNull();
  });
});
