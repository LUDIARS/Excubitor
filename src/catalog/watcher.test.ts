import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchFragments } from './watcher.js';

const originalArsRoot = process.env.EXCUBITOR_ARS_ROOT;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalArsRoot === undefined) delete process.env.EXCUBITOR_ARS_ROOT;
  else process.env.EXCUBITOR_ARS_ROOT = originalArsRoot;
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe('fragment watcher', () => {
  it('detects a fragment created after startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-watch-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    const onChange = vi.fn();
    const handle = watchFragments(onChange, { debounceMs: 10, pollIntervalMs: 20 });

    try {
      const repo = join(root, 'NewRepo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, 'excubitor.catalog.yaml'),
        'services:\n  - code: new\n    name: New\n    runtime: node\n',
        'utf8',
      );
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000 });
    } finally {
      handle.stop();
    }
  });

  // 既存 fragment の変更は個別 watcher が即時に拾う。 polling を十分長く設定することで、
  // fallback ではなく watcher 経由で検出できていることを保証する
  // (discovery root の recursive watch を外した代わりが機能しているかの回帰テスト)。
  it('detects edits to an existing fragment through its own watcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-watch-edit-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    const repo = join(root, 'ExistingRepo');
    mkdirSync(repo, { recursive: true });
    const fragment = join(repo, 'excubitor.catalog.yaml');
    writeFileSync(fragment, 'services:\n  - code: before\n    name: Before\n    runtime: node\n', 'utf8');

    const onChange = vi.fn();
    const handle = watchFragments(onChange, { debounceMs: 10, pollIntervalMs: 60_000 });

    try {
      writeFileSync(fragment, 'services:\n  - code: after\n    name: After\n    runtime: node\n', 'utf8');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000 });
    } finally {
      handle.stop();
    }
  });

  it('uses polling when fs.watch setup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-watch-missing-'));
    tempDirs.push(root);
    rmSync(root, { recursive: true, force: true });
    process.env.EXCUBITOR_ARS_ROOT = root;
    const onChange = vi.fn();
    const handle = watchFragments(onChange, { debounceMs: 10, pollIntervalMs: 20 });

    try {
      const repo = join(root, 'RecoveredRepo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, 'excubitor.catalog.yaml'),
        'services:\n  - code: recovered\n    name: Recovered\n    runtime: node\n',
        'utf8',
      );
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000 });
    } finally {
      handle.stop();
    }
  });
});
