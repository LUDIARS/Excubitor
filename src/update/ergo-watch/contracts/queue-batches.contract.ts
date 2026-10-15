import type { PackageUpdateBatch } from '../concordia-batches.js';
import type { DeliveryState } from '../delivery-state.js';
import type { DeliveryMessage } from '../types.js';

export default {
  post: (result: PackageUpdateBatch[], state: DeliveryState, _runId: string, messages: DeliveryMessage[]) => (
    JSON.stringify(result.slice(0, state.concordia_outbox.length)) === JSON.stringify(
      state.concordia_outbox.map((entry) => ({ runId: entry.run_id, messages: entry.messages })),
    )
    && (messages.length > 0 || state.outbox.length > 0 || result.length === state.concordia_outbox.length)
  ) || 'unsent batches must be resent first with the same runId, and an empty run must not add a batch',
};
