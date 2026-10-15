import { DISCORD_MESSAGE_LIMIT } from '../../../notify/discord-messages.js';
import { findSecretLeaks } from '../redact.js';
import type { WatchEvent } from '../types.js';

export default {
  post: (result: string[], _event: WatchEvent) => (
    result.length > 0
    && result.every((message) => message.length <= DISCORD_MESSAGE_LIMIT && findSecretLeaks(message).length === 0)
  ) || 'event messages must be non-empty, within the Discord limit and free of secrets',
};
