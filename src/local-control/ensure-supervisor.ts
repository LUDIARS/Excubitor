import { requestLocalControl, type LocalControlClientOptions } from './client.js';
import { activateInstalledSupervisor } from './supervisor-service-activation.js';

export interface EnsureSupervisorOptions extends LocalControlClientOptions {
  startupTimeoutMs?: number;
  probeIntervalMs?: number;
  activateSupervisor?: () => Promise<void>;
  probeSupervisor?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Ensure the persistent local supervisor exists before a mutating CLI command.
 * The Web API intentionally does not call this: it must report a missing
 * lifecycle authority instead of recreating one inside the Web failure domain.
 */
export async function ensureLocalControlSupervisor(
  options: EnsureSupervisorOptions = {},
): Promise<void> {
  const probeSupervisor = options.probeSupervisor ?? (() => canReachSupervisor(options));
  if (await probeSupervisor()) return;

  let activationError: unknown;
  try {
    await (options.activateSupervisor ?? activateInstalledSupervisor)();
  } catch (error) {
    // `/Run` can report "already running" while the durable process is still
    // establishing IPC. Probe through the normal readiness deadline before
    // turning the service-manager error into a CLI failure.
    activationError = error;
  }

  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  const intervalMs = options.probeIntervalMs ?? 100;
  const sleep = options.sleep ?? delay;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await probeSupervisor()) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  }
  if (activationError) {
    throw new Error(
      `local-control supervisor could not be activated by the OS service manager: ${errorMessage(activationError)}. ${recoveryGuidance()}`,
      { cause: activationError },
    );
  }
  throw new Error(
    `local-control supervisor was activated but did not become ready within ${timeoutMs}ms. ${recoveryGuidance()}`,
  );
}

async function canReachSupervisor(options: LocalControlClientOptions): Promise<boolean> {
  try {
    await requestLocalControl({
      target: { kind: 'excubitor' },
      action: 'status',
      actor: 'excubitorctl-bootstrap',
    }, {
      endpoint: options.endpoint,
      timeoutMs: Math.min(options.timeoutMs ?? 500, 500),
      maxLineBytes: options.maxLineBytes,
      createOperationId: options.createOperationId,
    });
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryGuidance(): string {
  return 'Install the durable service with scripts/install-service.ps1 (Windows) or scripts/install-service.sh (macOS/Linux), or run "npm run service" in a dedicated foreground terminal.';
}
