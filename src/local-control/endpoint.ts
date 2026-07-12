import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\excubitor-control-v1';

export interface EndpointEnvironment {
  EXCUBITOR_CONTROL_ENDPOINT?: string;
  EXCUBITOR_SERVICE_NAME?: string;
  USERDOMAIN?: string;
  USERNAME?: string;
  USER?: string;
  XDG_RUNTIME_DIR?: string;
}

export function localControlEndpoint(
  env: EndpointEnvironment = process.env,
  platform = process.platform,
  userId = typeof process.getuid === 'function' ? process.getuid() : 0,
): string {
  if (env.EXCUBITOR_CONTROL_ENDPOINT) return env.EXCUBITOR_CONTROL_ENDPOINT;
  if (platform === 'win32') {
    // The durable Windows supervisor must run as the installing user. Scoping
    // avoids accidental cross-account/instance collisions. Node's default pipe
    // DACL is retained; untrusted multi-user Windows hosts are outside this local
    // workstation control plane's threat model (see spec/plan/local-control.md).
    const account = [env.USERDOMAIN, env.USERNAME ?? env.USER].filter(Boolean).join('\\') || `uid-${userId}`;
    const service = env.EXCUBITOR_SERVICE_NAME?.trim() || 'Excubitor';
    const scope = createHash('sha256')
      .update(`${account.toLocaleLowerCase('en-US')}\0${service.toLocaleLowerCase('en-US')}`)
      .digest('hex')
      .slice(0, 16);
    return `${WINDOWS_PIPE_PREFIX}-${scope}`;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR || tmpdir();
  return join(runtimeDir, `excubitor-control-v1-${userId}.sock`);
}

export function isWindowsNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\');
}
