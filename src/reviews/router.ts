// /api/v1/reviews/*  ELUDIARS 全リポ�E review/ フォルダめEExcubitor から横断閲覧する、E
//
// Skill `ludiars-review` が各リポ�E review/<YYYY-MM-DD>/REVIEW_*.md と
// review/latest.json を書き�Eす、EここではファイルシスチE��経由でそ�Eまま返す、E

import { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arsRoot } from '../shared/roots.js';

// ワークスペースルートは shared/roots.ts に集約 (env EXCUBITOR_ARS_ROOT / LUDIARS_ROOT
// → cwd の親)。 旧 `LUDIARS_ROOT ?? 'E:/Document/Ars'` のドライブ焼き込みを廃止。
const LUDIARS_ROOT = resolve(arsRoot());

const REVIEW_FILES = [
  'REVIEW.md',
  'REVIEW_DESIGN.md',
  'REVIEW_VULNERABILITY.md',
  'REVIEW_IMPLEMENTATION.md',
  'REVIEW_MISSING_FEATURES.md',
  'REVIEW_QUALITY.md',
] as const;

type ReviewFile = typeof REVIEW_FILES[number];

interface LatestJson {
  date: string;
  weighted_score?: string;
  scores?: Record<string, string>;
  critical_count?: number;
  high_count?: number;
  fix_pr?: string | null;
}

function safeRepoName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

function safeDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeFile(name: string): ReviewFile | null {
  return (REVIEW_FILES as readonly string[]).includes(name) ? (name as ReviewFile) : null;
}

function reviewDir(repo: string): string {
  return join(LUDIARS_ROOT, repo, 'review');
}

function readLatest(repo: string): LatestJson | null {
  const p = join(reviewDir(repo), 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as LatestJson; } catch { return null; }
}

function listDates(repo: string): string[] {
  const dir = reviewDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => safeDate(n) && statSync(join(dir, n)).isDirectory())
    .sort()
    .reverse();
}

function listReviewedRepos(): string[] {
  if (!existsSync(LUDIARS_ROOT)) return [];
  const out: string[] = [];
  for (const name of readdirSync(LUDIARS_ROOT)) {
    if (!safeRepoName(name)) continue;
    const dir = reviewDir(name);
    if (existsSync(dir) && statSync(dir).isDirectory()) out.push(name);
  }
  return out.sort();
}

export function buildReviewsRouter(): Hono {
  const r = new Hono();

  r.get('/api/v1/reviews', (c) => {
    const items = listReviewedRepos().map((repo) => {
      const latest = readLatest(repo);
      return {
        repo,
        latest_date: latest?.date ?? null,
        weighted_score: latest?.weighted_score ?? null,
        critical_count: latest?.critical_count ?? 0,
        high_count: latest?.high_count ?? 0,
        fix_pr: latest?.fix_pr ?? null,
      };
    });
    return c.json({ items, root: LUDIARS_ROOT });
  });

  r.get('/api/v1/reviews/:repo', (c) => {
    const repo = safeRepoName(c.req.param('repo'));
    if (!repo) return c.json({ error: 'invalid repo' }, 400);
    const dates = listDates(repo);
    const latest = readLatest(repo);
    return c.json({ repo, dates, latest });
  });

  r.get('/api/v1/reviews/:repo/:date/:file', (c) => {
    const repo = safeRepoName(c.req.param('repo'));
    const date = safeDate(c.req.param('date'));
    const file = safeFile(c.req.param('file'));
    if (!repo || !date || !file) return c.json({ error: 'invalid path' }, 400);
    const p = join(reviewDir(repo), date, file);
    if (!existsSync(p)) return c.json({ error: 'not_found' }, 404);
    const text = readFileSync(p, 'utf8');
    return c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  return r;
}


