import type Database from 'better-sqlite3';
import { requireMutualPeer } from '../federation/peer-auth.js';
import { getPeer } from '../federation/store.js';
import { createNamedLogger } from '../shared/logger.js';
import { ColabCli } from './cli.js';
import { runColabProcess } from './cli-process.js';
import { colabSiteClient } from './client.js';
import { loadColabSettings, type ColabSettings } from './config.js';
import { buildColabMeshRoutes } from './federation-routes.js';
import { ColabJournal } from './journal.js';
import { buildLocalColabRoutes } from './local-routes.js';
import { ColabRunner } from './runner.js';

const logger = createNamedLogger('excubitor.colab');

export function createColabRuntime(db: Database.Database, allowLaunch: () => boolean) {
  let settings: ColabSettings = {};
  try { settings = loadColabSettings(process.env.EXCUBITOR_COLAB_CONFIG_FILE); }
  catch { logger.error('Invalid Colab settings; submission is disabled'); }
  const runner = new ColabRunner(new ColabJournal(db), new ColabCli(runColabProcess), settings.colab, allowLaunch);
  runner.startRecovery();
  return {
    meshRouter: buildColabMeshRoutes(runner, requireMutualPeer()),
    localRouter: buildLocalColabRoutes({ runner, sitePeerId: settings.hq?.sitePeerId, findPeer: getPeer, client: colabSiteClient }),
    close: () => runner.close(),
  };
}
