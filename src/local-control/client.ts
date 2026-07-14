import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { localControlEndpoint } from './endpoint.js';
import { NewlineJsonFramer } from './line-framer.js';
import {
  LOCAL_CONTROL_MAX_LINE_BYTES,
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LocalControlRequestSchema,
  LocalControlResponseSchema,
  type LocalControlRequest,
  type LocalControlRequestInput,
  type LocalControlResponse,
} from './protocol.js';

export interface LocalControlClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  createOperationId?: () => string;
  maxLineBytes?: number;
}

export async function requestLocalControl(
  input: LocalControlRequestInput,
  options: LocalControlClientOptions = {},
): Promise<LocalControlResponse> {
  const request = LocalControlRequestSchema.parse({
    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation_id: input.operation_id ?? options.createOperationId?.() ?? randomUUID(),
    target: input.target,
    action: input.action,
    actor: input.actor ?? 'local-tool',
    dispatch: input.dispatch ?? 'execute',
    ...(input.parameters ? { parameters: input.parameters } : {}),
  });
  return exchange(request, options);
}

async function exchange(
  request: LocalControlRequest,
  options: LocalControlClientOptions,
): Promise<LocalControlResponse> {
  const endpoint = options.endpoint ?? localControlEndpoint();
  const timeoutMs = options.timeoutMs;
  const maxLineBytes = options.maxLineBytes ?? LOCAL_CONTROL_MAX_LINE_BYTES;

  return new Promise<LocalControlResponse>((resolve, reject) => {
    const socket = createConnection(endpoint);
    const framer = new NewlineJsonFramer(maxLineBytes);
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    // Execute requests may legitimately wait behind another target operation or
    // a 30-minute build. A default deadline would turn a completed side effect
    // into an ambiguous client failure. Callers that only perform bounded probes
    // can still opt into a timeout explicitly.
    if (timeoutMs !== undefined) {
      socket.setTimeout(timeoutMs, () => fail(new Error(`local-control request timed out after ${timeoutMs}ms`)));
    }
    socket.once('error', (error) => fail(error));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`, 'utf8');
    });
    socket.on('data', (chunk: string) => {
      if (settled) return;
      try {
        const line = framer.push(chunk)[0];
        if (!line) return;
        const response = LocalControlResponseSchema.parse(JSON.parse(line));
        if (response.operation_id !== request.operation_id) {
          fail(new Error(`local-control operation id mismatch: expected ${request.operation_id}`));
          return;
        }
        settled = true;
        socket.end();
        resolve(response);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('end', () => {
      if (!settled) fail(new Error('local-control connection closed before a response was received'));
    });
  });
}

export type {
  LocalControlRequestInput,
  LocalControlResponse,
} from './protocol.js';
