import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Catalog } from './loader.js';
import { discoverServices } from '../discovery/scan.js';
import { runScan } from './auto-catalog.js';

vi.mock('../discovery/scan.js', () => ({
  discoverServices: vi.fn(),
}));

const originalAutoCatalogPath = process.env.EXCUBITOR_AUTO_CATALOG_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.EXCUBITOR_AUTO_CATALOG_PATH = originalAutoCatalogPath;
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runScan ignored_codes', () => {
  it('does not recreate ignored auto catalog entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'excubitor-auto-catalog-'));
    tempDirs.push(dir);
    const repoDir = join(dir, 'Memoria');
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, 'docker-compose.yml'), 'services: {}\n', 'utf8');

    const autoCatalogPath = join(dir, 'services.auto.yaml');
    process.env.EXCUBITOR_AUTO_CATALOG_PATH = autoCatalogPath;
    writeFileSync(autoCatalogPath, 'ignored_codes:\n  - memoria\nservices: []\n', 'utf8');

    vi.mocked(discoverServices).mockResolvedValue({
      scannedRoot: dir,
      missing: [],
      candidates: [{
        name: 'Memoria',
        path: repoDir,
        hasPackageJson: false,
        hasComposeFile: true,
        hasDevScript: false,
        suggestedRuntime: 'docker-compose',
        remote: null,
      }],
    });

    const result = await runScan({ services: [] } as unknown as Catalog);

    expect(result.created).toEqual([]);
    expect(result.skipped).toContainEqual({ name: 'Memoria', reason: 'ignored code (memoria)' });

    const parsed = load(readFileSync(autoCatalogPath, 'utf8')) as { ignored_codes?: unknown; services?: unknown };
    expect(parsed.ignored_codes).toEqual(['memoria']);
    expect(parsed.services).toEqual([]);
  });
});
