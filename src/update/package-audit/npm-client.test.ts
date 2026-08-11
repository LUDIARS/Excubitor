import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execCapture: vi.fn() }));

vi.mock('../../shared/exec.js', () => ({ execCapture: mocks.execCapture }));

import { npmLatestVersion } from './npm-client.js';

describe('npm package audit diagnostics', () => {
  it('redacts audit paths, private endpoints, and credentials from failures', async () => {
    const cwd = 'C:/private/project';
    const credentialAssignment = ['_auth', 'Token=placeholder-token'].join('');
    mocks.execCapture.mockResolvedValueOnce({
      ok: false,
      code: 1,
      stdout: '',
      stderr: [
        `failure in ${cwd}`,
        'registry https://registry.example.invalid/npm',
        credentialAssignment,
      ].join('\n'),
    });

    const result = await npmLatestVersion(
      { command: process.execPath, prefixArgs: ['npm-cli.js'] },
      cwd,
      1_000,
      'example',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('[audit-target]');
    expect(result.failure.message).toContain('[url]');
    expect(result.failure.message).toContain('[redacted]');
    expect(result.failure.message).not.toContain('private/project');
    expect(result.failure.message).not.toContain('registry.example.invalid');
    expect(result.failure.message).not.toContain('placeholder-token');
  });
});
