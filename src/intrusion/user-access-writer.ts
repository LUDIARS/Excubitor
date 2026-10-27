import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { UserAccessEntry } from './user-access-log.js';

/** Vg JSONL envelope, independently discoverable service streams.
 * @spec spec/feature/user-access-log.md#storage
 */
export function userAccessWriter(root: string): (entry: UserAccessEntry) => void {
  return entry => {
    if (!/^excubitor-user-access-[a-z0-9_-]{1,64}$/.test(entry.service)) throw new Error('invalid user access stream');
    const directory = join(root, entry.service);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, new Date(entry.ts).toISOString().slice(0, 10) + '.jsonl'),
      JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  };
}
