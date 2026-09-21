/**
 * 契約述語そのもののテスト。 注入 (`augur inject apply --rule contract-wrap`) を
 * 外しても述語はリポ資産として残るため、 ここから直接呼んで検証する。
 */

import { describe, expect, it } from 'vitest';
import injectContract from './runtime-config-inject.contract.js';
import readContract from './runtime-config-read.contract.js';
import saveContract from './runtime-config-save.contract.js';
import validationContract from './runtime-config-validation.contract.js';
import { ServiceRuntimeConfigValidationError } from './config-store.js';

describe('C-5 getServiceRuntimeConfig contract', () => {
  it('accepts a catalog service code and rejects an ambiguous one', () => {
    expect(readContract.pre('genius')).toBe(true);
    expect(readContract.pre(' genius ')).toMatch(/service code/);
    expect(readContract.pre('Genius')).toMatch(/service code/);
  });

  it('accepts null or a JSON object and rejects an array', () => {
    expect(readContract.post(null)).toBe(true);
    expect(readContract.post({ dataDir: './data' })).toBe(true);
    expect(readContract.post(['dataDir'])).toMatch(/JSON object/);
  });
});

describe('C-6 saveServiceRuntimeConfig status contract', () => {
  it('accepts a status of exactly configured and keys', () => {
    expect(saveContract.post({ configured: true, keys: ['dataDir'] })).toBe(true);
    expect(saveContract.post({ configured: false, keys: [] })).toBe(true);
  });

  it('rejects a status that leaks the store path or the saved values', () => {
    expect(saveContract.post({ configured: true, keys: ['dataDir'], storePath: 'C:/x' })).toMatch(/configured and keys/);
    expect(saveContract.post({ configured: true, keys: [{ dataDir: './data' }] })).toMatch(/configured and keys/);
  });
});

describe('C-7 runtime config validation contract', () => {
  it('treats a ServiceRuntimeConfigValidationError as the contracted failure', () => {
    expect(validationContract.postThrow(new ServiceRuntimeConfigValidationError('bad'))).toBe(true);
    expect(validationContract.postThrow(new Error('disk full'))).toMatch(/fail as ServiceRuntimeConfigValidationError/);
  });

  it('requires a status object on the accepted path', () => {
    expect(validationContract.post({ configured: true, keys: ['dataDir'] })).toBe(true);
    expect(validationContract.post({ dataDir: './data' })).toMatch(/status object/);
  });
});

describe('C-8 resolveInjectEnv contract', () => {
  it('accepts an env map without a runtime config', () => {
    expect(injectContract.post({ GENIUS_PORT: '4230' })).toBe(true);
  });

  it('accepts a serialized JSON object and rejects anything else', () => {
    expect(injectContract.post({ EXCUBITOR_SERVICE_CONFIG_JSON: '{"dataDir":"./data"}' })).toBe(true);
    expect(injectContract.post({ EXCUBITOR_SERVICE_CONFIG_JSON: '["dataDir"]' })).toMatch(/serialized JSON object/);
    expect(injectContract.post({ EXCUBITOR_SERVICE_CONFIG_JSON: 'not json' })).toMatch(/serialized JSON object/);
  });

  it('rejects a non-string env value', () => {
    expect(injectContract.post({ GENIUS_PORT: 4230 })).toMatch(/must all be strings/);
  });
});
