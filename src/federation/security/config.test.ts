import { expect, it } from 'vitest';
import { MeshSecuritySchema } from './config.js';
import { securityConfig } from './test-fixtures.js';

it('keeps Cc recipient separate from the Ex peer identity', () => {
  const config = securityConfig();
  expect(MeshSecuritySchema.parse({ ...config, concordia: { audience: 'hq/concordia' } }).concordia)
    .toEqual({ audience: 'hq/concordia' });
  expect(MeshSecuritySchema.parse(config).concordia).toBeUndefined();
});

it('rejects Ex audiences, wildcard recipients and self-supplied credentials in the Cc recipient', () => {
  for (const concordia of [
    { audience: 'hq/excubitor' }, { audience: '*/concordia' },
    { audience: 'hq/concordia', clientSecret: 'not-accepted' },
  ]) {
    expect(MeshSecuritySchema.safeParse({ ...securityConfig(), concordia }).success).toBe(false);
  }
});
