import { describe, expect, it } from 'vitest';
import { BootstrapOptionsSchema } from './options.js';
import { bootstrapCheckoutName } from './repository.js';
import { NodeServiceHealthSchema } from '../federation/health-types.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
describe('approved bootstrap sources', () => {
  it('maps the approved external source to its catalog checkout', () => {
    expect(bootstrapCheckoutName('VGA-GLAB/GLAB-Hub')).toBe('GLAB');
    expect(bootstrapCheckoutName('LUDIARS/Tabula')).toBe('Tabula');
    expect(NodeServiceHealthSchema.shape.repository.parse('VGA-GLAB/GLAB-Hub')).toBe('VGA-GLAB/GLAB-Hub');
  });
  it('rejects alternate owners, paths, URLs and caller-selected destinations', () => {
    for (const repository of ['VGA-GLAB/Other', 'other/GLAB-Hub', 'VGA-GLAB/GLAB-Hub/../Other', 'https://github.com/VGA-GLAB/GLAB-Hub', 'VGA-GLAB/GLAB-Hub.git']) {
      expect(BootstrapOptionsSchema.safeParse({ repository }).success).toBe(false);
      expect(NodeServiceHealthSchema.shape.repository.safeParse(repository).success).toBe(false);
      expect(() => bootstrapCheckoutName(repository)).toThrow();
    }
    expect(BootstrapOptionsSchema.safeParse({ repository: 'VGA-GLAB/GLAB-Hub', destination: 'Other' }).success).toBe(false);
  });
});
