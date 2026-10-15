import { DISCORD_MESSAGE_LIMIT } from '../../../notify/discord-messages.js';
import type { PackageUpdateBatch } from '../concordia-batches.js';
import type { DeliveryMessage } from '../types.js';

export default {
  post: (result: PackageUpdateBatch[], _runId: string, messages: DeliveryMessage[]) => (
    result.every((batch) => (
      batch.runId.length >= 1 && batch.runId.length <= 128
      && batch.messages.length >= 1 && batch.messages.length <= 20
      && batch.messages.every((message) => message.text.length >= 1 && message.text.length <= DISCORD_MESSAGE_LIMIT)
    ))
    && new Set(result.map((batch) => batch.runId)).size === result.length
    && JSON.stringify(result.flatMap((batch) => batch.messages)) === JSON.stringify(
      messages.map((message) => ({ text: message.content, private: message.channel === 'private' })),
    )
  ) || 'batches must fit the Concordia contract and keep every message, its order and its privacy',
};
