import { describe, it, expect } from 'vitest';
import { parseReleaseManifest } from './manifest.js';

function base() {
  return {
    name: 'demo',
    primary: 'app',
    components: [
      { code: 'app', role: 'primary', path: '/x/app' },
      { code: 'tool', role: 'cli', path: '/x/tool', bin_name: 'tool', bin_entry: 'bin/tool.mjs' },
    ],
  };
}

describe('parseReleaseManifest', () => {
  it('既定値を埋めて検証する', () => {
    const m = parseReleaseManifest(base());
    expect(m.output_dir).toBe('dist/releases');
    expect(m.start_command).toEqual({ cmd: 'node', args: ['dist/index.js'] });
    expect(m.runtime.bundle).toBe(false);
    const app = m.components.find((c) => c.code === 'app')!;
    expect(app.include).toEqual(['dist', 'package.json', 'package-lock.json']);
    expect(app.prod_install).toBe(true);
  });

  it('primary が role=primary に一致しないと throw', () => {
    const bad = base();
    bad.primary = 'tool';
    expect(() => parseReleaseManifest(bad)).toThrow();
  });

  it('role=primary が複数あると throw', () => {
    const bad = base();
    bad.components.push({ code: 'app2', role: 'primary', path: '/x/app2' } as never);
    expect(() => parseReleaseManifest(bad)).toThrow();
  });

  it('role=cli に bin_name/bin_entry が無いと throw', () => {
    const bad = base();
    bad.components[1] = { code: 'tool', role: 'cli', path: '/x/tool' } as never;
    expect(() => parseReleaseManifest(bad)).toThrow();
  });
});
