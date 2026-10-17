import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { vaultDir } from '../vault/vault-store.js';
import { ProfileSchema, type TerminalProfile } from './schema.js';

/** Non-secret connection metadata only; credentials remain in Vault. @implements SPEC-TERMINAL-CONNECTIONS */
export class TerminalProfileStore {
  constructor(private readonly path = join(vaultDir(), 'terminal-connections.json')) {}
  list(): TerminalProfile[] {
    if (!existsSync(this.path)) return [];
    return z.object({ version: z.literal(1), profiles: z.array(ProfileSchema) }).parse(JSON.parse(readFileSync(this.path, 'utf8'))).profiles;
  }
  get(id: string): TerminalProfile | undefined { return this.list().find((p) => p.id === id); }
  put(profile: TerminalProfile): void {
    const validated = ProfileSchema.parse(profile);
    this.write([...this.list().filter((p) => p.id !== profile.id), validated]);
  }
  remove(id: string): void { this.write(this.list().filter((p) => p.id !== id)); }
  private write(profiles: TerminalProfile[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, profiles }, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
