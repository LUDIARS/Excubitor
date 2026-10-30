/**
 * Administrator command for Excubitor's local tokens. Values are printed only to the terminal of the
 * OS user that owns the token files / master key (file ACL is the boundary, not the loopback API).
 *
 *   npm run agent-token -- mesh                 拠点間 (federation) token。 相手拠点のピア登録に貼る
 *   npm run agent-token -- rotate-mesh          mesh token を新しい値に入れ替える (Ex 再起動 + 相手拠点の登録更新が要る)
 *   npm run agent-token -- service <code>       そのサービス専用の secret-agent token (Ex の外で起動するサービス用)
 *
 * @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT
 */

import { getOrCreateMeshToken, meshTokenPath, rotateMeshToken } from '../federation/mesh-token.js';
import { isServiceCode, serviceAgentToken } from './service-agent-token.js';

const USAGE = 'usage: agent-token -- mesh | rotate-mesh | service <code>\n';

function main(argv: string[]): number {
  const [command, arg] = argv;
  if (command === 'mesh') {
    process.stderr.write(`mesh token (${meshTokenPath()}):\n`);
    process.stdout.write(`${getOrCreateMeshToken()}\n`);
    return 0;
  }
  if (command === 'rotate-mesh') {
    const token = rotateMeshToken();
    process.stderr.write('mesh token rotated. Restart Excubitor and update this site\'s token on every peer.\n');
    process.stdout.write(`${token}\n`);
    return 0;
  }
  if (command === 'service') {
    if (!arg || !isServiceCode(arg)) {
      process.stderr.write(USAGE);
      return 2;
    }
    process.stdout.write(`${serviceAgentToken(arg)}\n`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
