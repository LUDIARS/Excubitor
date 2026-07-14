import { parentPort, workerData } from 'node:worker_threads';

import { closeDb, openReadOnlyDb } from '../db/index.js';
import { downtimeSummariesForServices } from './downtime.js';

interface DowntimeWorkerData {
  dbPath: string;
}

interface DowntimeWorkerRequest {
  id: number;
  codes: string[];
  windowMin?: number;
  now?: number;
}

const port = parentPort;
if (!port) throw new Error('downtime worker requires a parent port');

const data = workerData as DowntimeWorkerData;
openReadOnlyDb(data.dbPath);
process.once('exit', closeDb);

port.on('message', (request: DowntimeWorkerRequest) => {
  try {
    const summaries = downtimeSummariesForServices(request.codes, request.windowMin, request.now);
    port.postMessage({ id: request.id, ok: true, summaries: [...summaries.entries()] });
  } catch (error) {
    port.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
});
