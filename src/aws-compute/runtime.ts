import type Database from 'better-sqlite3';
import { createNamedLogger } from '../shared/logger.js';
import type { Vault } from '../vault/vault.js';
import { AwsCredentialSource } from './credentials.js';
import { Ec2Provider } from './ec2.js';
import { FargateProvider } from './fargate.js';
import { JobJournal } from './job-journal.js';
import { OrphanSweep } from './orphan-sweep.js';
import type { ProviderFactory } from './provider.js';
import { ComputeRegistry } from './registry.js';
import { buildAwsComputeRouter } from './router.js';
import { ComputeWorker } from './worker.js';

const logger = createNamedLogger('excubitor.aws-compute');
const TICK = 1_000;

export function createAwsComputeRuntime(db: Database.Database, vault: () => Pick<Vault, 'valuesOf'>, allowLaunch: () => boolean) {
  const registry = new ComputeRegistry(db);
  const journal = new JobJournal(db, registry);
  const credentials = new AwsCredentialSource({ valuesOf: (keys) => vault().valuesOf(keys) });
  const provider: ProviderFactory = async (target) => {
    const protocol = await credentials.protocol(target.region);
    return target.kind === 'ec2' ? new Ec2Provider(protocol, target) : new FargateProvider(protocol, target);
  };
  const worker = new ComputeWorker(journal, provider, () => registry.owner());
  const sweep = new OrphanSweep(registry, journal, provider);
  const timer = setInterval(tick, TICK).unref();
  let inFlight: Promise<void> | undefined;

  function tick(): void {
    if (inFlight) return;
    inFlight = run().catch(() => {
      logger.error('AWS compute lifecycle tick failed');
    }).finally(() => { inFlight = undefined; });
  }

  async function run(): Promise<void> {
    await worker.step(allowLaunch);
    await sweep.step();
  }

  return {
    router: buildAwsComputeRouter({ registry, journal, credentials, sweep, allowLaunch }),
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
