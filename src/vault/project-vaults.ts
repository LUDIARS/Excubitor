/** Project inventory. Secret values stay in separately encrypted Vault documents. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const ProjectSchema = z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(128) });
const InventorySchema = z.object({ version: z.literal(1), projects: z.array(ProjectSchema) });
export type VaultProject = z.infer<typeof ProjectSchema>;

export class ProjectVaults {
  constructor(private readonly root: string) {}

  list(): VaultProject[] {
    const file = join(this.root, 'vault-projects.json');
    return existsSync(file) ? InventorySchema.parse(JSON.parse(readFileSync(file, 'utf8'))).projects : [];
  }

  register(project: VaultProject): void {
    ProjectSchema.parse(project);
    const projects = this.list();
    const existing = projects.find((p) => p.id === project.id);
    if (existing?.name === project.name) return;
    if (existing) existing.name = project.name;
    else projects.push(project);
    mkdirSync(this.root, { recursive: true });
    const file = join(this.root, 'vault-projects.json');
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, projects }), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
  }

  directory(id: string): string {
    ProjectSchema.shape.id.parse(id);
    return join(this.root, 'vault-projects', createHash('sha256').update(id, 'utf8').digest('hex'));
  }
}
