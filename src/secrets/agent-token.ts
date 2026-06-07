/**
 * secret-agent のローカル認証トークン。
 *
 * Excubitor を「常駐 secret-agent」として使うとき、 loopback でも誰でも叩けると
 * secret が漏れる。 そこで本人のみ読めるローカルトークンを 1 本持ち、 呼び出し側は
 * Authorization: Bearer <token> を付ける (loopback + token の二段)。
 *
 * トークンの出所 (優先順):
 *   1. env EXCUBITOR_AGENT_TOKEN (明示指定)
 *   2. トークンファイル (無ければ生成)。 リポジトリ外・本人のみ読める権限 (0600)。
 *      - 既定パス: EXCUBITOR_AGENT_TOKEN_PATH → AppData/.config 配下 secret-agent.token
 *
 * クライアント (各サービス) は同じ env かファイルから token を読む (同一マシン前提)。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.secrets.agent-token');

/** トークンファイルのパス。 config.enc と同じ基底ディレクトリ下に置く。 */
export function agentTokenPath(): string {
  const override = process.env.EXCUBITOR_AGENT_TOKEN_PATH;
  if (override && override.length > 0) return override;
  const base =
    process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'Excubitor', 'secret-agent.token');
}

let cached: string | null = null;

/**
 * トークンを取得 (無ければ生成して 0600 で保存)。 boot 時に 1 回呼ぶ想定。
 * env EXCUBITOR_AGENT_TOKEN があればそれを最優先。
 */
export function getOrCreateAgentToken(): string {
  if (cached) return cached;
  const fromEnv = process.env.EXCUBITOR_AGENT_TOKEN;
  if (fromEnv && fromEnv.length > 0) {
    cached = fromEnv;
    return cached;
  }
  const path = agentTokenPath();
  try {
    if (existsSync(path)) {
      const t = readFileSync(path, 'utf8').trim();
      if (t.length > 0) {
        cached = t;
        return cached;
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to read agent token, regenerating');
  }
  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
    logger.info({ path }, 'generated secret-agent token');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to persist agent token (using in-memory)');
  }
  cached = token;
  return cached;
}

/** Authorization ヘッダ値 (`Bearer xxx` or 生 token) を検証する。 定数時間比較。 */
export function verifyAgentToken(headerValue: string | undefined | null): boolean {
  if (!headerValue) return false;
  const provided = headerValue.toLowerCase().startsWith('bearer ')
    ? headerValue.slice(7).trim()
    : headerValue.trim();
  if (!provided) return false;
  const expected = getOrCreateAgentToken();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
