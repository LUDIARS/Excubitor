import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import type { Service } from '../catalog/loader.js';
import type { ComposeVersionOverride } from './compose-version-override.js';
import { createComposeVersionOverride } from './compose-version-override.js';

describe('compose runtime version override', () => {
  it('quotes service names and injects both version contracts into every service', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'excubitor-compose-source-test-'));
    const composeFile = join(sourceDirectory, 'compose.yaml');
    let override: ComposeVersionOverride | null = null;

    try {
      await writeFile(
        composeFile,
        'services:\n  web-app:\n    image: example/web\n  worker:\n    image: example/worker\n',
        'utf8',
      );
      override = await createComposeVersionOverride(service(composeFile), '1.2.3+build');

      const parsed = load(await readFile(override.path, 'utf8')) as {
        services: Record<string, { environment: Record<string, string> }>;
      };
      expect(parsed.services).toEqual({
        'web-app': {
          environment: {
            EXCUBITOR_SERVICE_VERSION: '1.2.3+build',
            VITE_EXCUBITOR_SERVICE_VERSION: '1.2.3+build',
          },
        },
        worker: {
          environment: {
            EXCUBITOR_SERVICE_VERSION: '1.2.3+build',
            VITE_EXCUBITOR_SERVICE_VERSION: '1.2.3+build',
          },
        },
      });

      await override.dispose();
      await expect(access(override.path)).rejects.toThrow();
      override = null;
    } finally {
      try {
        await override?.dispose();
      } finally {
        await rm(sourceDirectory, { recursive: true, force: true });
      }
    }
  });

  it('does not expose compose contents or local paths in YAML diagnostics', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'excubitor-compose-source-test-'));
    const composeFile = join(sourceDirectory, 'compose.yaml');
    const privateValue = 'private-value-that-must-not-be-reported';

    try {
      await writeFile(
        composeFile,
        `services:\n  web:\n    environment: [${privateValue}\n`,
        'utf8',
      );
      let message = '';
      try {
        await createComposeVersionOverride(service(composeFile), '1.2.3');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('invalid YAML');
      expect(message).not.toContain(privateValue);
      expect(message).not.toContain(sourceDirectory);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });
});

function service(composeFile: string): Service {
  return {
    code: 'compose-demo',
    name: 'Compose Demo',
    runtime: 'docker-compose',
    compose_file: composeFile,
    disabled: false,
    develop_derived: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'no',
    max_restart: 0,
    required_env: [],
  } as Service;
}
