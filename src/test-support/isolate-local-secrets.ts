/**
 * Test setup: keep config.enc, token files and the master key store out of the developer's real %APPDATA%/Excubitor.
 * A test that reaches the default paths must never create or overwrite the site's real config.enc, mesh token,
 * secret-agent token or master key (they authenticate peers and decrypt config.enc / remote_peers).
 *
 * The paths are forced (not `??=`): a value inherited from the shell or the service environment would point
 * the tests at real data. A test that stubs one of these and restores it falls back to the temp value set here.
 * Any write that still resolves into the real dir fails through the guard.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRealConfigWriteGuard, isInsideAny, realExcubitorDirs } from './real-config-guard.js';

const realDirs = realExcubitorDirs(process.env);
const dir = mkdtempSync(join(tmpdir(), 'excubitor-test-secrets-'));
if (isInsideAny(dir, realDirs)) {
  throw new Error(`test setup: temp dir ${dir} is inside the real Excubitor config dir; refusing to run`);
}

process.env.APPDATA = join(dir, 'appdata');
process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
process.env.EXCUBITOR_CONFIG_PATH = join(dir, 'config.enc');
process.env.EXCUBITOR_MASTER_KEY_DIR = dir;
process.env.EXCUBITOR_MESH_TOKEN_PATH = join(dir, 'mesh.token');
process.env.EXCUBITOR_AGENT_TOKEN_PATH = join(dir, 'secret-agent.token');
// 実拠点の master 鍵を env で持ち込まない (テストが要るときは各テストで stub する)。
delete process.env.EXCUBITOR_MASTER_KEY;

installRealConfigWriteGuard(realDirs);
