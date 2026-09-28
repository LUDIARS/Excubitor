import { z } from 'zod';

/** Approved sources and checkout identities; callers cannot choose a destination.
 * @implements SPEC-SERVICE-BOOTSTRAP
 */
export const BootstrapRepositorySchema = z.string().regex(/^(?:LUDIARS\/[A-Za-z0-9][A-Za-z0-9_-]*|VGA-GLAB\/GLAB-Hub)$/);

export function bootstrapCheckoutName(repository: string): string {
  BootstrapRepositorySchema.parse(repository);
  return repository === 'VGA-GLAB/GLAB-Hub' ? 'GLAB' : repository.split('/')[1]!;
}
