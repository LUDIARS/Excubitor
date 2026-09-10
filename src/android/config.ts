import { z } from 'zod';

export const AndroidAppSchema = z.object({
  adb: z.string().min(1),
  serial: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  apk: z.string().min(1),
  package: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  activity: z.string().regex(/^\.?[A-Za-z][A-Za-z0-9_.$]*$/),
}).strict();

export type AndroidApp = z.infer<typeof AndroidAppSchema>;
