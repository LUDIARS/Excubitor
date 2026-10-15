import type { DeliveryChannel, WatchEvent } from '../types.js';

export default {
  post: (result: Record<DeliveryChannel, WatchEvent[]>, _events: WatchEvent[], privacy: Map<string, boolean>) => (
    result.public.every((event) => !event.private && privacy.get(event.host) === false)
  ) || 'private hosts, private dependencies and unknown hosts must not reach the public channel',
};
