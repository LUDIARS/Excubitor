import { DISCORD_MESSAGE_LIMIT } from '../../../notify/discord-messages.js';

const compact = (value: string): string => value.replace(/\s+/g, '');

export default {
  post: (result: string[], blocks: string[], limit = DISCORD_MESSAGE_LIMIT) => (
    result.every((message) => message.length <= limit)
    && compact(result.join('')) === compact(blocks.join(''))
  ) || 'packed messages must fit the limit without dropping content',
};
