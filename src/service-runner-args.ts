const SERVICE_NAME_PREFIX = '--service-name=';
const PORT_PREFIX = '--port=';

/** Validate service-runner arguments and apply them before supervisor modules load. */
export function configureServiceRunnerEnvironment(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  let serviceName = normalizedConfiguredServiceName(env.EXCUBITOR_SERVICE_NAME);
  let port: string | undefined;
  let sawServiceName = false;
  let sawPort = false;

  for (const argument of argv) {
    if (argument.startsWith(SERVICE_NAME_PREFIX)) {
      if (sawServiceName) throw new Error('duplicate --service-name argument');
      sawServiceName = true;
      serviceName = validServiceName(argument.slice(SERVICE_NAME_PREFIX.length));
      continue;
    }
    if (argument.startsWith(PORT_PREFIX)) {
      if (sawPort) throw new Error('duplicate --port argument');
      sawPort = true;
      port = validPort(argument.slice(PORT_PREFIX.length));
      continue;
    }
    throw new Error(
      `unsupported argument '${argument}'; expected --service-name=<name> or --port=<1..65535>`,
    );
  }

  if (serviceName !== undefined) env.EXCUBITOR_SERVICE_NAME = serviceName;
  if (port !== undefined) env.EXCUBITOR_PORT = port;
  // The durable supervisor has one invariant operating mode on every OS;
  // inherited interactive-shell settings must not silently disable autostart.
  env.EXCUBITOR_SERVICE_MODE = '1';
  env.EXCUBITOR_SAFE_MODE = '0';
}

function normalizedConfiguredServiceName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return validServiceName(value.trim());
}

function validServiceName(value: string): string {
  if (value.length === 0 || /[^A-Za-z0-9_.-]/u.test(value)) {
    throw new Error(`invalid service name '${value}' (allowed: A-Z a-z 0-9 _ . -)`);
  }
  return value;
}

function validPort(value: string): string {
  if (value.length === 0 || /[^0-9]/u.test(value)) {
    throw new Error(`invalid port '${value}' (expected 1..65535)`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port '${value}' (expected 1..65535)`);
  }
  return String(port);
}
