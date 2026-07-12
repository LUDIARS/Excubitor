import { z } from 'zod';

export const LOCAL_CONTROL_PROTOCOL_VERSION = 1 as const;
export const LOCAL_CONTROL_MAX_LINE_BYTES = 64 * 1024;
export const LOCAL_CONTROL_OUTPUT_JSON_BYTES = 24 * 1024;
export const LOCAL_CONTROL_COMMAND_JSON_BYTES = 4 * 1024;
export const LOCAL_CONTROL_ERROR_JSON_BYTES = 4 * 1024;

export const LocalControlActionSchema = z.enum([
  'start',
  'stop',
  'restart',
  'status',
  'kill-port',
  'claude-port-fix',
]);
export type LocalControlAction = z.infer<typeof LocalControlActionSchema>;
export const LocalControlDispatchModeSchema = z.enum(['execute', 'prepare', 'commit']);
export type LocalControlDispatchMode = z.infer<typeof LocalControlDispatchModeSchema>;

export const LocalControlTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), code: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('excubitor') }).strict(),
]);
export type LocalControlTarget = z.infer<typeof LocalControlTargetSchema>;

const OperationIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const LocalControlRequestSchema = z.object({
  protocol_version: z.literal(LOCAL_CONTROL_PROTOCOL_VERSION),
  operation_id: OperationIdSchema,
  target: LocalControlTargetSchema,
  action: LocalControlActionSchema,
  actor: z.string().min(1).max(256),
  dispatch: LocalControlDispatchModeSchema.default('execute'),
  parameters: z.object({
    port: z.number().int().min(1).max(65_535).optional(),
    prompt: z.string().max(4_096).optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const emergency = value.action === 'kill-port' || value.action === 'claude-port-fix';
  if (value.target.kind === 'excubitor' && emergency) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'emergency actions require a service target' });
  }
  if (!emergency && value.parameters) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'parameters are supported only for emergency actions' });
  }
});
export type LocalControlRequest = z.infer<typeof LocalControlRequestSchema>;

export interface LocalControlRequestInput {
  operation_id?: string;
  target: LocalControlTarget;
  action: LocalControlAction;
  actor?: string;
  dispatch?: LocalControlDispatchMode;
  parameters?: { port?: number; prompt?: string };
}

export const ControlResultSchema = z.object({
  ok: z.boolean(),
  stdout: z.string().max(LOCAL_CONTROL_OUTPUT_JSON_BYTES),
  stderr: z.string().max(LOCAL_CONTROL_OUTPUT_JSON_BYTES),
  exit_code: z.number().int(),
  command: z.string().max(LOCAL_CONTROL_COMMAND_JSON_BYTES),
  stdout_truncated: z.boolean().optional(),
  stderr_truncated: z.boolean().optional(),
  command_truncated: z.boolean().optional(),
}).strict();
export type LocalControlResult = z.infer<typeof ControlResultSchema>;

/** Keep one control response below the newline-framed IPC limit, including JSON escaping. */
export function boundControlResult(result: LocalControlResult): LocalControlResult {
  const stdout = truncateJsonString(result.stdout, LOCAL_CONTROL_OUTPUT_JSON_BYTES);
  const stderr = truncateJsonString(result.stderr, LOCAL_CONTROL_OUTPUT_JSON_BYTES);
  const command = truncateJsonString(result.command, LOCAL_CONTROL_COMMAND_JSON_BYTES);
  return {
    ...result,
    stdout: stdout.value,
    stderr: stderr.value,
    command: command.value,
    ...(stdout.truncated ? { stdout_truncated: true } : {}),
    ...(stderr.truncated ? { stderr_truncated: true } : {}),
    ...(command.truncated ? { command_truncated: true } : {}),
  };
}

export const ServiceStatusPayloadSchema = z.object({
  kind: z.literal('service-status'),
  code: z.string(),
  runtime: z.string(),
  state: z.enum(['running', 'stopped', 'unknown']),
  running: z.boolean().nullable(),
  pid: z.number().int().positive().nullable(),
}).strict();
export type ServiceStatusPayload = z.infer<typeof ServiceStatusPayloadSchema>;

export const ExcubitorStatusPayloadSchema = z.object({
  kind: z.literal('excubitor-status'),
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'restarting', 'crashed']),
  desired_state: z.enum(['running', 'stopped']),
  pid: z.number().int().positive().nullable(),
  restart_count: z.number().int().nonnegative(),
  last_exit_code: z.number().int().nullable(),
  last_signal: z.string().nullable(),
  last_error: z.string().nullable(),
  instance_token: z.string().nullable().default(null),
}).strict();
export type ExcubitorStatusPayload = z.infer<typeof ExcubitorStatusPayloadSchema>;

export const EmergencyResultSchema = z.object({
  ok: z.boolean(),
  action: z.enum(['kill-port', 'claude-port-fix']),
  code: z.string().min(1).max(128),
  port: z.number().int().min(1).max(65_535).nullable(),
  pids: z.array(z.number().int().positive()).max(128),
  stdout: z.string().max(LOCAL_CONTROL_OUTPUT_JSON_BYTES),
  stderr: z.string().max(LOCAL_CONTROL_OUTPUT_JSON_BYTES),
  prompt: z.string().max(LOCAL_CONTROL_COMMAND_JSON_BYTES).optional(),
  stdout_truncated: z.boolean().optional(),
  stderr_truncated: z.boolean().optional(),
  prompt_truncated: z.boolean().optional(),
}).strict();
export type LocalEmergencyResult = z.infer<typeof EmergencyResultSchema>;

export function boundEmergencyResult(result: LocalEmergencyResult): LocalEmergencyResult {
  const stdout = truncateJsonString(result.stdout, LOCAL_CONTROL_OUTPUT_JSON_BYTES);
  const stderr = truncateJsonString(result.stderr, LOCAL_CONTROL_OUTPUT_JSON_BYTES);
  const prompt = result.prompt === undefined
    ? undefined
    : truncateJsonString(result.prompt, LOCAL_CONTROL_COMMAND_JSON_BYTES);
  return {
    ...result,
    stdout: stdout.value,
    stderr: stderr.value,
    ...(prompt ? { prompt: prompt.value } : {}),
    ...(stdout.truncated ? { stdout_truncated: true } : {}),
    ...(stderr.truncated ? { stderr_truncated: true } : {}),
    ...(prompt?.truncated ? { prompt_truncated: true } : {}),
  };
}

export const LocalControlCompletedPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('control-result'), value: ControlResultSchema }).strict(),
  ServiceStatusPayloadSchema,
  ExcubitorStatusPayloadSchema,
  z.object({ kind: z.literal('emergency-result'), value: EmergencyResultSchema }).strict(),
]);
export type LocalControlCompletedPayload = z.infer<typeof LocalControlCompletedPayloadSchema>;
export const LocalControlAcceptedPayloadSchema = z.object({
  kind: z.literal('accepted'),
  deferred: z.literal(true),
  target_key: z.string(),
}).strict();
export const LocalControlPayloadSchema = z.union([
  LocalControlCompletedPayloadSchema,
  LocalControlAcceptedPayloadSchema,
]);
export type LocalControlPayload = z.infer<typeof LocalControlPayloadSchema>;

export const LocalControlErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(LOCAL_CONTROL_ERROR_JSON_BYTES),
}).strict();
export type LocalControlError = z.infer<typeof LocalControlErrorSchema>;

const LocalControlResponseBase = {
  protocol_version: z.literal(LOCAL_CONTROL_PROTOCOL_VERSION),
  operation_id: z.string().min(1),
} as const;

export const LocalControlResponseSchema = z.discriminatedUnion('state', [
  z.object({
    ...LocalControlResponseBase,
    ok: z.literal(true),
    state: z.literal('accepted'),
    payload: LocalControlAcceptedPayloadSchema,
    error: z.never().optional(),
  }).strict(),
  z.object({
    ...LocalControlResponseBase,
    ok: z.literal(true),
    state: z.literal('completed'),
    payload: LocalControlCompletedPayloadSchema.optional(),
    error: z.never().optional(),
  }).strict(),
  z.object({
    ...LocalControlResponseBase,
    ok: z.literal(false),
    state: z.literal('failed'),
    payload: LocalControlCompletedPayloadSchema.optional(),
    error: LocalControlErrorSchema,
  }).strict(),
]);
export type LocalControlResponse = z.infer<typeof LocalControlResponseSchema>;

export function targetKey(target: LocalControlTarget): string {
  return target.kind === 'service' ? `service:${target.code}` : 'excubitor';
}

export function failedResponse(
  operationId: string,
  code: string,
  message: string,
  payload?: LocalControlCompletedPayload,
): LocalControlResponse {
  const boundedMessage = truncateJsonString(message, LOCAL_CONTROL_ERROR_JSON_BYTES).value;
  return {
    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation_id: operationId,
    ok: false,
    state: 'failed',
    ...(payload ? { payload } : {}),
    error: { code, message: boundedMessage || 'local-control operation failed' },
  };
}

function truncateJsonString(value: string, maxEncodedBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxEncodedBytes) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxEncodedBytes) low = middle;
    else high = middle - 1;
  }
  let bounded = value.slice(0, low);
  const last = bounded.charCodeAt(bounded.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
  return { value: bounded, truncated: true };
}
