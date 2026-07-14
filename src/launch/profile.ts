/**
 * 起動セット (ランチャー) プロファイルの読み書き. launch_profile singleton (id=1).
 *
 * - configured: 初回ウィザード完了済みか
 * - autoLaunch : boot 時に selection を自動起動するか
 * - selection  : 起動対象 service code の配列
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface LaunchProfile {
  configured: boolean;
  autoLaunch: boolean;
  selection: string[];
  updatedAt: number | null;
}

interface ProfileRow {
  configured: number;
  auto_launch: number;
  selection: string;
  updated_at: number | null;
}

const DEFAULT_PROFILE: LaunchProfile = {
  configured: false,
  autoLaunch: true,
  selection: [],
  updatedAt: null,
};

function parseSelection(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function getLaunchProfile(): LaunchProfile {
  const rows = db().all(sql`
    SELECT configured, auto_launch, selection, updated_at
    FROM launch_profile WHERE id = 1 LIMIT 1
  `) as unknown as ProfileRow[];
  const row = rows[0];
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    configured: Boolean(row.configured),
    autoLaunch: Boolean(row.auto_launch),
    selection: parseSelection(row.selection),
    updatedAt: row.updated_at ?? null,
  };
}

export interface SaveProfileInput {
  selection: string[];
  autoLaunch?: boolean;
  /** 明示指定が無ければ「保存したら configured 済み」とみなす. */
  configured?: boolean;
}

export function saveLaunchProfile(input: SaveProfileInput): LaunchProfile {
  const selection = input.selection.filter((x) => typeof x === 'string');
  const autoLaunch = input.autoLaunch ?? true;
  const configured = input.configured ?? true;
  db().run(sql`
    UPDATE launch_profile
    SET selection = ${JSON.stringify(selection)},
        auto_launch = ${autoLaunch ? 1 : 0},
        configured = ${configured ? 1 : 0},
        updated_at = ${Date.now()}
    WHERE id = 1
  `);
  return getLaunchProfile();
}
