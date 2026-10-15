import { NO_NEW_EVENTS } from '../summary-format.js';

export default {
  post: (result: string, eventCount: number, _messages: string[]) => (
    eventCount !== 0 || result.startsWith(NO_NEW_EVENTS)
  ) || 'a run without events must say 新規なし',
};
