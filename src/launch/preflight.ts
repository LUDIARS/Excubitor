/**
 * 起動前チェック (preflight)。 起動セットの各サービスについて、 起動に必要な前提が
 * 揃っているかを spawn 前に検査する:
 *   - cwd / compose_file の実在
 *   - Infisical inject 対象なら Excubitor の machine identity 有無 + secret 解決可否
 *
 * 「事前に起動チェックする」 (2026-06-04 ユーザ指示) の実体。 NG があっても throw せず
 * レポートで返し、 UI / orchestrator が判断する。
 */

import { existsSync } from 'node:fs';
import type { Service } from '../catalog/loader.js';
import { readIdentity, fetchProjectSecrets, toEnvMap } from '../secrets/infisical.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  kind: 'cwd' | 'compose_file' | 'infisical';
  status: CheckStatus;
  detail: string;
}

export interface ServicePreflight {
  code: string;
  name: string;
  ready: boolean; // fail が 1 つも無い
  injectedKeys: number; // Infisical relay で渡せる env 数
  checks: PreflightCheck[];
}

export interface PreflightReport {
  ok: boolean; // 全サービス ready
  identityPresent: boolean;
  needsIdentity: boolean; // inject 対象が 1 つでもある
  services: ServicePreflight[];
}

async function checkInfisical(svc: Service): Promise<{ check: PreflightCheck; injected: number }> {
  const cfg = svc.infisical;
  if (!cfg || !cfg.inject) {
    return { check: { kind: 'infisical', status: 'ok', detail: 'inject 不要' }, injected: 0 };
  }
  const id = readIdentity();
  if (!id) {
    return {
      check: { kind: 'infisical', status: 'fail', detail: 'Excubitor の machine identity (INFISICAL_*) が無い' },
      injected: 0,
    };
  }
  try {
    const secrets = await fetchProjectSecrets(id, cfg.project_id, cfg.environment);
    const env = toEnvMap(secrets, { prefix: cfg.prefix, include: cfg.include, exclude: cfg.exclude });
    const n = Object.keys(env).length;
    return {
      check: {
        kind: 'infisical',
        status: n > 0 ? 'ok' : 'warn',
        detail: `${cfg.project_id}/${cfg.environment} から ${n} 件解決`,
      },
      injected: n,
    };
  } catch (err) {
    return {
      check: { kind: 'infisical', status: 'fail', detail: `fetch 失敗: ${(err as Error).message}` },
      injected: 0,
    };
  }
}

function checkPaths(svc: Service): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  if (svc.runtime === 'node' || svc.runtime === 'dev-process-md') {
    if (!svc.cwd) {
      checks.push({ kind: 'cwd', status: 'fail', detail: 'cwd が未設定' });
    } else if (!existsSync(svc.cwd)) {
      checks.push({ kind: 'cwd', status: 'fail', detail: `cwd が存在しない: ${svc.cwd}` });
    } else {
      checks.push({ kind: 'cwd', status: 'ok', detail: svc.cwd });
    }
  }
  if (svc.runtime === 'docker-compose') {
    if (!svc.compose_file) {
      checks.push({ kind: 'compose_file', status: 'fail', detail: 'compose_file が未設定' });
    } else if (!existsSync(svc.compose_file)) {
      checks.push({ kind: 'compose_file', status: 'fail', detail: `compose_file が存在しない: ${svc.compose_file}` });
    } else {
      checks.push({ kind: 'compose_file', status: 'ok', detail: svc.compose_file });
    }
  }
  return checks;
}

/** 選択された service を preflight する。 */
export async function runPreflight(services: Service[], codes: string[]): Promise<PreflightReport> {
  const want = new Set(codes);
  const targets = services.filter((s) => want.has(s.code));
  const needsIdentity = targets.some((s) => s.infisical?.inject);
  const identityPresent = readIdentity() !== null;

  const result: ServicePreflight[] = [];
  for (const svc of targets) {
    const checks = checkPaths(svc);
    const { check: infCheck, injected } = await checkInfisical(svc);
    checks.push(infCheck);
    result.push({
      code: svc.code,
      name: svc.name,
      ready: !checks.some((c) => c.status === 'fail'),
      injectedKeys: injected,
      checks,
    });
  }

  return {
    ok: result.every((r) => r.ready),
    identityPresent,
    needsIdentity,
    services: result,
  };
}
