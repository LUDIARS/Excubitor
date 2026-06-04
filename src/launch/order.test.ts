import { describe, it, expect } from 'vitest';
import { startTier, orderForStart, orderForStop } from './order.js';
import type { Service } from '../catalog/loader.js';

function svc(code: string, project_code?: string): Service {
  return {
    code,
    name: code,
    project_code,
    monitor_only: false,
    runtime: 'node',
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
  } as Service;
}

describe('startTier', () => {
  it('infra/cernere/corpus/vantanhub に専用 tier を割り当てる', () => {
    expect(startTier(svc('infra-pg', 'infra'))).toBe(0);
    expect(startTier(svc('cernere-backend', 'cernere'))).toBe(1);
    expect(startTier(svc('corpus', 'corpus'))).toBe(2);
    expect(startTier(svc('vantanhub', 'vantanhub'))).toBe(3);
  });

  it('その他 leaf は tier 5', () => {
    expect(startTier(svc('bibliotheca', 'bibliotheca'))).toBe(5);
  });
});

describe('orderForStart', () => {
  const services = [
    svc('bibliotheca', 'bibliotheca'),
    svc('corpus', 'corpus'),
    svc('cernere-backend', 'cernere'),
    svc('infra-pg', 'infra'),
  ];

  it('tier 昇順にまとめる (infra→cernere→corpus→leaf)', () => {
    const tiers = orderForStart(services, ['bibliotheca', 'corpus', 'cernere-backend', 'infra-pg']);
    expect(tiers.map((t) => t.tier)).toEqual([0, 1, 2, 5]);
    expect(tiers[0]!.services[0]!.code).toBe('infra-pg');
    expect(tiers[3]!.services[0]!.code).toBe('bibliotheca');
  });

  it('選択外は除外する', () => {
    const tiers = orderForStart(services, ['corpus']);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.services[0]!.code).toBe('corpus');
  });
});

describe('orderForStop', () => {
  it('起動の逆順 (leaf を先に落とす)', () => {
    const services = [svc('corpus', 'corpus'), svc('infra-pg', 'infra'), svc('bib', 'bibliotheca')];
    const order = orderForStop(services, ['corpus', 'infra-pg', 'bib']).map((s) => s.code);
    expect(order).toEqual(['bib', 'corpus', 'infra-pg']);
  });
});
