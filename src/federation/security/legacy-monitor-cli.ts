/**
 * Administrator command for the mesh auth migration period.
 *
 *   npm run mesh:legacy-monitor -- status
 *   npm run mesh:legacy-monitor -- enable --reason "<why / until when>"
 *   npm run mesh:legacy-monitor -- disable
 *
 * Enabling keeps health/node monitoring of registered peers with the legacy shared token while
 * the Cr workload configuration is not deployed yet. Operations, bundles and Vault stay denied.
 *
 * @implements SPEC-SECURITY-MESH-LEGACY-MONITOR
 */

import { describeMeshAuth } from './legacy-monitor.js';
import {
  disableLegacyMonitorMigration,
  enableLegacyMonitorMigration,
  legacyMonitorMigrationPath,
  readMeshAuthPolicy,
} from './legacy-monitor-store.js';

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const path = legacyMonitorMigrationPath();
  if (command === 'enable') {
    const index = rest.indexOf('--reason');
    const reason = index >= 0 ? rest[index + 1]?.trim() : '';
    if (!reason) {
      process.stderr.write('enable requires --reason "<why / until when>"\n');
      return 2;
    }
    enableLegacyMonitorMigration(reason);
  } else if (command === 'disable') {
    disableLegacyMonitorMigration();
  } else if (command !== 'status') {
    process.stderr.write('usage: mesh:legacy-monitor -- status | enable --reason "<text>" | disable\n');
    return 2;
  }
  process.stdout.write(`${JSON.stringify({ file: path, ...describeMeshAuth(readMeshAuthPolicy) }, null, 2)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
