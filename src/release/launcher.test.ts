import { describe, it, expect } from 'vitest';
import {
  renderStartBat,
  renderStartSh,
  renderCliShimBat,
  renderCliShimSh,
  buildVersionInfo,
  type LauncherOptions,
} from './launcher.js';

function opts(over: Partial<LauncherOptions> = {}): LauncherOptions {
  return {
    name: 'demo',
    displayName: 'Demo',
    version: '1.2.3',
    startCmd: 'node',
    startArgs: ['dist/index.js'],
    cliBins: [{ name: 'lictor', subdir: 'packages/lictor', entry: 'bin/lictor.mjs' }],
    bundledNode: false,
    readmeNotes: [],
    ...over,
  };
}

describe('renderStartBat', () => {
  it('bin を PATH に載せ app/ で node を叩く', () => {
    const bat = renderStartBat(opts());
    expect(bat).toContain('set "PATH=%ROOT%bin;%PATH%"');
    expect(bat).toContain('pushd "%ROOT%app"');
    expect(bat).toContain('node dist\\index.js %*');
  });

  it('runtime 同梱なら相対 node.exe を使う', () => {
    const bat = renderStartBat(opts({ bundledNode: true }));
    expect(bat).toContain('"%ROOT%runtime\\node.exe" dist\\index.js');
  });
});

describe('renderStartSh', () => {
  it('PATH に bin、 app へ cd、 exec node', () => {
    const sh = renderStartSh(opts());
    expect(sh).toContain('export PATH="$ROOT/bin:$PATH"');
    expect(sh).toContain('cd "$ROOT/app"');
    expect(sh).toContain('exec node dist/index.js "$@"');
  });
});

describe('cli shim', () => {
  it('bat shim は packages/<code>/entry を node 起動', () => {
    const bat = renderCliShimBat({ name: 'lictor', subdir: 'packages/lictor', entry: 'bin/lictor.mjs' }, false);
    expect(bat).toContain('node "%~dp0..\\packages\\lictor\\bin\\lictor.mjs" %*');
  });

  it('sh shim は相対 entry を exec', () => {
    const sh = renderCliShimSh({ name: 'lictor', subdir: 'packages/lictor', entry: 'bin/lictor.mjs' }, false);
    expect(sh).toContain('exec node "$DIR/../packages/lictor/bin/lictor.mjs" "$@"');
  });
});

describe('buildVersionInfo', () => {
  it('component メタを束ねる', () => {
    const v = buildVersionInfo('demo', '1.0.0', '2026-06-10T00:00:00.000Z', [
      { code: 'app', role: 'primary', branch: 'main', commit: 'abc1234', dirty: false },
    ]);
    expect(v).toEqual({
      name: 'demo',
      version: '1.0.0',
      built_at: '2026-06-10T00:00:00.000Z',
      components: [{ code: 'app', role: 'primary', branch: 'main', commit: 'abc1234', dirty: false }],
    });
  });
});
