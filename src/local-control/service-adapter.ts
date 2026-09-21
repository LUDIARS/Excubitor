import type { Service } from '../catalog/loader.js';
import type { ControlAction } from '../control/docker-compose.js';
import {
  requestLocalControl,
  type LocalControlClientOptions,
} from './client.js';
import type {
  ExcubitorStatusPayload,
  LocalControlResult,
  LocalEmergencyResult,
} from './protocol.js';

export type LocalControlProxyError = 'unavailable' | 'invalid_response';
export type LocalToolControlResult = LocalControlResult & {
  local_control_error?: LocalControlProxyError;
};
export type LocalToolEmergencyResult = LocalEmergencyResult & {
  local_control_error?: LocalControlProxyError;
};

export async function controlServiceViaLocalTool(
  service: Service,
  action: ControlAction,
  actor: string,
): Promise<LocalToolControlResult> {
  try {
    const response = await requestLocalControl({
      target: { kind: 'service', code: service.code },
      action,
      actor,
    });
    if (response.payload?.kind === 'control-result') return response.payload.value;
    return adapterFailure(
      service.code,
      action,
      response.error?.message ?? 'local-control returned no service result',
      'invalid_response',
    );
  } catch (error) {
    return adapterFailure(
      service.code,
      action,
      error instanceof Error ? error.message : String(error),
      isUnavailable(error) ? 'unavailable' : 'invalid_response',
    );
  }
}

export async function emergencyServiceViaLocalTool(
  service: Service,
  action: 'kill-port' | 'claude-port-fix',
  actor: string,
  parameters: { port?: number; prompt?: string } = {},
): Promise<LocalToolEmergencyResult> {
  try {
    const response = await requestLocalControl({
      target: { kind: 'service', code: service.code },
      action,
      actor,
      ...(parameters.port !== undefined || parameters.prompt !== undefined ? { parameters } : {}),
    });
    if (response.payload?.kind === 'emergency-result') return response.payload.value;
    return emergencyAdapterFailure(
      service.code,
      action,
      response.error?.message ?? 'local-control returned no emergency result',
      'invalid_response',
    );
  } catch (error) {
    return emergencyAdapterFailure(
      service.code,
      action,
      error instanceof Error ? error.message : String(error),
      isUnavailable(error) ? 'unavailable' : 'invalid_response',
    );
  }
}

/**
 * Excubitor 自身の再起動を supervisor に依頼する。 supervisor は受理 (deferred) を返してから
 * backend を止めて新しい backend を起動する (design.md §16.4)。 ok は「受理された」の意味で、
 * 再起動の完了ではない。
 */
export async function restartExcubitorViaLocalTool(actor: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const response = await requestLocalControl({ target: { kind: 'excubitor' }, action: 'restart', actor });
    return response.ok ? { ok: true, error: null } : { ok: false, error: response.error?.message ?? 'restart rejected' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function localControlStatus(
  options: LocalControlClientOptions = {},
): Promise<ExcubitorStatusPayload> {
  const response = await requestLocalControl({
    target: { kind: 'excubitor' },
    action: 'status',
    actor: 'excubitor-api',
  }, options);
  if (response.payload?.kind === 'excubitor-status') return response.payload;
  throw new Error(response.error?.message ?? 'local-control returned no Excubitor status');
}

function adapterFailure(
  code: string,
  action: ControlAction,
  message: string,
  localControlError: LocalControlProxyError,
): LocalToolControlResult {
  return {
    ok: false,
    stdout: '',
    stderr: message,
    exit_code: -1,
    command: `excubitorctl service ${code} ${action}`,
    local_control_error: localControlError,
  };
}

function emergencyAdapterFailure(
  code: string,
  action: 'kill-port' | 'claude-port-fix',
  message: string,
  localControlError: LocalControlProxyError,
): LocalToolEmergencyResult {
  return {
    ok: false,
    action,
    code,
    port: null,
    pids: [],
    stdout: '',
    stderr: message,
    local_control_error: localControlError,
  };
}

function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ENXIO') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|closed before a response|pipe.*busy/i.test(message);
}
