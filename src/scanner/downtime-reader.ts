import {
  downtimeSummariesForServices,
  type DowntimeSummary,
} from './downtime.js';

export type DowntimeSummaryReader = (
  codes: string[],
  windowMin?: number,
  now?: number,
) => Promise<Map<string, DowntimeSummary>>;

/** In-memory DBs cannot be shared with a worker, so tests/embedders may inject this reader. */
export const readDowntimeSummariesInProcess: DowntimeSummaryReader = async (
  codes,
  windowMin,
  now,
) => downtimeSummariesForServices(codes, windowMin, now);
