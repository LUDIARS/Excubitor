#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

// The local management API signs peer requests; never pass peer credentials on the command line.
try {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, peer: { type: 'string' },
    request: { type: 'string' }, operation: { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (!values.url || Boolean(values.request) === Boolean(values.operation)) {
    throw new Error('Usage: node scripts/service-bootstrap.mjs --url <local-Ex-URL> [--peer <id>] (--request <json-file> | --operation <id>)');
  }
  const base = new URL(values.url);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Use the local Excubitor loopback HTTP origin; --peer selects the remote site');
  }
  const route = values.peer ? '/api/v1/peers/' + encodeURIComponent(values.peer) + '/operations' : '/api/v1/operations';
  const path = values.operation ? route + '/' + encodeURIComponent(values.operation) : route;
  const body = values.request ? JSON.stringify(JSON.parse(await readFile(values.request, 'utf8'))) : undefined;
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {}, body,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(String(error.message) + '\nIf a POST may have reached the server, inspect operation history before retrying.\n');
  process.exitCode = 1;
}
