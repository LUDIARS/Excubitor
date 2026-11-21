import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { fileName, gpu, identifier, MAX_OUTPUTS, RESULT_NAME, revision, sha256 } from './protocol.js';

const absolutePath = z.string().min(1).max(1024).refine(isAbsolute);
const program = z.object({
  path: absolutePath.refine(path => /\.(?:py|ipynb)$/.test(path)),
  sourceRevision: revision,
  sha256,
  gpu,
  outputs: z.array(fileName).max(MAX_OUTPUTS).refine(names =>
    names.every(name => name.toLowerCase() !== RESULT_NAME) &&
    new Set(names.map(name => name.toLowerCase())).size === names.length),
}).strict();

const siteSchema = z.object({
  enabled: z.boolean(),
  cliPath: absolutePath,
  jobRoot: absolutePath,
  osUser: identifier,
  ownerId: identifier,
  hqPeerId: identifier,
  maxRuntimeSeconds: z.number().int().min(1).max(12 * 60 * 60),
  programs: z.record(identifier, program).refine(programs =>
    Object.keys(programs).length > 0 && Object.keys(programs).length <= 64),
}).strict();
const settings = z.object({
  colab: siteSchema.optional(),
  hq: z.object({ sitePeerId: identifier }).strict().optional(),
}).strict();

export type ColabSiteSettings = z.infer<typeof siteSchema>;
export type ColabSettings = z.infer<typeof settings>;
export type ColabProgram = z.infer<typeof program>;

export function loadColabSettings(path: string | undefined): ColabSettings {
  if (!path) return {};
  if (!isAbsolute(path)) throw new Error('invalid_colab_config');
  return settings.parse(JSON.parse(readFileSync(path, 'utf8')));
}
