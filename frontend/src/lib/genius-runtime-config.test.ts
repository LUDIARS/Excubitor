import { describe, expect, it } from 'vitest';
import { createGeniusRuntimeConfigTemplate } from './genius-runtime-config.js';

describe('createGeniusRuntimeConfigTemplate', () => {
  it('uses the haiku role for both Claude model defaults', () => {
    const config = JSON.parse(createGeniusRuntimeConfigTemplate());

    expect(config.distill).toMatchObject({
      backend: 'claude-cli',
      model: 'haiku',
      sensitiveCheckModel: 'haiku',
    });
    expect(config.embedding.model).toBe('bge-m3');
    expect(config.distill.ollamaModel).toBe('gemma4:12b');
  });
});
