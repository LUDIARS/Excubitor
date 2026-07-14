import { dirname } from 'node:path';
import type { Service } from '../catalog/loader.js';
import { execCapture, type ExecResult } from '../shared/exec.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.process.build');

export interface ServiceBuildResult extends ExecResult {
  command: string;
  skipped: boolean;
}

export async function runServiceBuild(svc: Service, reason: string): Promise<ServiceBuildResult> {
  if (!svc.build_command) {
    return { ok: true, code: 0, stdout: '', stderr: '', command: '(no build_command)', skipped: true };
  }

  const cwd = buildCwd(svc);
  logger.info({ code: svc.code, command: svc.build_command, cwd, reason }, 'running service build');
  const result = await execCapture(svc.build_command, [], cwd, 1_800_000, true);
  logger.info({ code: svc.code, ok: result.ok, exit_code: result.code, reason }, 'service build complete');
  return { ...result, command: svc.build_command, skipped: false };
}

function buildCwd(svc: Service): string {
  if (svc.cwd) return svc.cwd;
  if (svc.start_script) return dirname(svc.start_script);
  if (svc.exec) return dirname(svc.exec);
  return process.cwd();
}
