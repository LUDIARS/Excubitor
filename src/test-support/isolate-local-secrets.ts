/**
 * Test setup: keep token files and the master key store out of the developer's real %APPDATA%/Excubitor.
 * A test that reaches the default paths must never create or overwrite the site's real mesh token,
 * secret-agent token or master key (they authenticate peers and decrypt config.enc / remote_peers).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'excubitor-test-secrets-'));
process.env.EXCUBITOR_MESH_TOKEN_PATH ??= join(dir, 'mesh.token');
process.env.EXCUBITOR_AGENT_TOKEN_PATH ??= join(dir, 'secret-agent.token');
process.env.EXCUBITOR_MASTER_KEY_DIR ??= dir;
