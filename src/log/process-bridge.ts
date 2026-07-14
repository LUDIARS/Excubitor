/**
 * ProcessManager の line emit めElogbus に橋渡し、E
 */
import { registerLineHandler } from '../process/manager.js';
import { publish } from './bus.js';

export function attachProcessBridge(): void {
  registerLineHandler((svc, channel, line) => {
    void publish({
      service_code: svc.code,
      channel,
      ts: new Date(),
      line,
    });
  });
}


