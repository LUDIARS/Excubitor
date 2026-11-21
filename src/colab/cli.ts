import { join } from 'node:path';
import type { CliIdentity, ColabJob } from './journal.js';
import type { ColabProcess } from './cli-process.js';

const CALL_TIMEOUT_MS = 15_000;
const ALLOCATION_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const SESSION_LINE = /^\[([A-Za-z0-9?._-]+)\] (\S+) \| Hardware: .+ \| Shape: .+ \| Variant: \S+$/;
const NO_SESSIONS = '[colab] No active sessions found on server.';

interface SessionEntry { name: string; endpoint: string }

export function parseColabSessions(stdout: string): SessionEntry[] | null {
  const lines = stdout.trim().split(/\r?\n/).map(line => line.trim());
  const sessions: SessionEntry[] = [];
  for (const line of lines) {
    const match = SESSION_LINE.exec(line);
    if (match?.[1] && match[2]) sessions.push({ name: match[1], endpoint: match[2] });
    else if (line.includes('| Hardware:')) return null;
  }
  if (sessions.length > 0) return lines.includes(NO_SESSIONS) ? null : sessions;
  return lines.includes(NO_SESSIONS) ? [] : null;
}

const sessionName = (job: ColabJob) => `ex-${job.id}`;
export const colabJobDir = (job: ColabJob) => join(job.cli.jobRoot, job.id);

export class ColabCli {
  constructor(private readonly run: ColabProcess) {}

  async ready(cli: CliIdentity, signal?: AbortSignal): Promise<boolean> {
    // The CLI's account query requires valid OAuth and ignores stdin in the service.
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    return (await this.run({ ...cli, cwd: cli.jobRoot, args: ['--auth', 'oauth2', 'usage'],
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout })).ok;
  }

  async sessions(job: ColabJob, signal: AbortSignal): Promise<SessionEntry[] | null> {
    // The CLI can print an empty inventory after some authentication failures.
    if (!await this.ready(job.cli, signal)) return null;
    const result = await this.command(job, ['sessions'], signal, CALL_TIMEOUT_MS, true);
    return result.ok && !result.stderrObserved ? parseColabSessions(result.stdout) : null;
  }

  namedEndpoint(job: ColabJob, sessions: SessionEntry[]): string | null {
    const named = sessions.filter(entry => entry.name === sessionName(job));
    return named.length === 1 ? named[0]?.endpoint ?? null : null;
  }

  async allocate(job: ColabJob, signal: AbortSignal): Promise<boolean> {
    return (await this.command(job, ['new', '-s', sessionName(job), '--gpu', job.request.gpu],
      signal, ALLOCATION_TIMEOUT_MS)).ok;
  }

  async execute(job: ColabJob, program: string, signal: AbortSignal): Promise<boolean> {
    const context = JSON.stringify({ attemptId: job.request.idempotencyKey, sourceRevision: job.request.sourceRevision, uploads: {} });
    return (await this.command(job, ['exec', '-s', sessionName(job), '-f', program,
      '--env', `CC_CLOUD_INPUT=${context}`, '--timeout', '0'], signal)).ok;
  }

  async download(job: ColabJob, name: string, file: string, signal: AbortSignal): Promise<boolean> {
    return (await this.command(job, ['download', '-s', sessionName(job), `content/${name}`, file],
      signal, DOWNLOAD_TIMEOUT_MS)).ok;
  }

  async stop(job: ColabJob, signal: AbortSignal): Promise<void> {
    await this.command(job, ['stop', '-s', sessionName(job)], signal, CALL_TIMEOUT_MS);
  }

  private command(job: ColabJob, args: string[], signal: AbortSignal, timeout?: number, capture = false) {
    return this.run({
      ...job.cli, cwd: job.cli.jobRoot, args: ['--auth', 'oauth2', '--config', join(colabJobDir(job), 'cli-sessions.json'), ...args],
      signal: timeout === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeout)]), capture,
    });
  }
}
