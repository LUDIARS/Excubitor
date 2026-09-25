import type { ViewerEntry } from './catalog.js';
import type { ViewerDirectory } from './manifest.js';

export type ViewerServiceStatus = 'up' | 'down' | 'unknown';

const DOWN_STATES = new Set(['stopped', 'crashed']);

/** Adds a display-only status without exposing the monitor snapshot itself. */
export function viewerServiceEntries(directory: ViewerDirectory): Array<ViewerEntry & { status: ViewerServiceStatus }> {
  const states = new Map<string, string>();
  for (const project of directory.monitor?.()?.projects ?? []) {
    for (const component of project.components) {
      if (!states.has(component.code)) states.set(component.code, component.state);
    }
  }
  return directory.entries().map((entry) => ({ ...entry, status: statusFor(states.get(entry.code)) }));
}

function statusFor(state: string | undefined): ViewerServiceStatus {
  if (state === 'running') return 'up';
  if (state && DOWN_STATES.has(state)) return 'down';
  return 'unknown';
}
