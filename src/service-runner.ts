import { configureServiceRunnerEnvironment } from './service-runner-args.js';

let argumentsValid = true;
try {
  configureServiceRunnerEnvironment(process.argv.slice(2), process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[service-runner] ${message}\n`);
  process.exitCode = 2;
  argumentsValid = false;
}

if (argumentsValid) {
  const [
    { createLocalControlSupervisor },
    { createNamedLogger },
    { applyInfisicalToEnv: loadInfisicalIdentity },
    { startSupervisorWithInfisicalIdentity },
  ] = await Promise.all([
    import('./local-control/supervisor.js'),
    import('./shared/logger.js'),
    import('./secrets/config-store.js'),
    import('./service-runner-infisical.js'),
  ]);
  const logger = createNamedLogger('excubitor.supervisor');
  const supervisor = createLocalControlSupervisor({ rootDir: process.cwd() });
  let stopping = false;

  async function stop(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'stopping local-control supervisor');
    try {
      await supervisor.close();
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'supervisor shutdown failed');
      process.exitCode = 1;
    }
  }

  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });

  try {
    // backend と supervisor は別プロセスのため、backend 側での env 注入はここへ継承されない。
    await startSupervisorWithInfisicalIdentity(loadInfisicalIdentity, logger, supervisor);
    logger.info('local-control supervisor listening');
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, 'supervisor start failed');
    process.exitCode = 1;
  }
}
