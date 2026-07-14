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
import { resolveServiceInfisical } from '../secrets/config-store.js';
import { listListeners, type PortListener } from '../scanner/ports.js';
import { managedPortsForService } from '../catalog/ports.js';
import { resolveInjectEnv } from '../process/inject.js';
import { requiredEnvKeysForService, validateStartupEnv } from '../process/startup-env.js';
import { getServiceByCode } from '../process/service-registry.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  kind: 'cwd' | 'compose_file' | 'infisical' | 'requires_secret' | 'env' | 'start_script' | 'port' | 'disabled';
  status: CheckStatus;
  detail: string;
}

async function checkRequiredEnv(svc: Service): Promise<PreflightCheck> {
  const required = requiredEnvKeysForService(svc);
  if (required.length === 0) {
    return { kind: 'env', status: 'ok', detail: 'no required env configured' };
  }
  try {
    const env = await resolveInjectEnv(svc);
    const validation = validateStartupEnv(svc, env);
    if (validation.ready) {
      return { kind: 'env', status: 'ok', detail: `${validation.required.length} required env present` };
    }
    return {
      kind: 'env',
      status: 'fail',
      detail: `missing required env: ${validation.missing.join(', ')}`,
    };
  } catch (err) {
    return { kind: 'env', status: 'fail', detail: (err as Error).message };
  }
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
  const cfg = resolveServiceInfisical(svc.code, svc.infisical);
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

/**
 * `requires_secret` (他サービスの Infisical project から NAMED secret を借りる設定) の preflight。
 * Aedilis のように自分自身は infisical.inject が無くても requires_secret だけ持ちうるため、
 * checkInfisical (自身の secret) とは別チェックとして分離し、 fail 理由を混同させない。
 */
async function checkRequiresSecret(svc: Service): Promise<{ check: PreflightCheck; injected: number }> {
  const requests = svc.requires_secret ?? [];
  if (requests.length === 0) {
    return { check: { kind: 'requires_secret', status: 'ok', detail: 'cross-service secret 不要' }, injected: 0 };
  }
  const id = readIdentity();
  if (!id) {
    return {
      check: {
        kind: 'requires_secret',
        status: 'fail',
        detail: 'Excubitor の machine identity (INFISICAL_*) が無い',
      },
      injected: 0,
    };
  }
  let injected = 0;
  for (const req of requests) {
    const source = getServiceByCode(req.service);
    if (!source) {
      return {
        check: {
          kind: 'requires_secret',
          status: 'fail',
          detail: `source service "${req.service}" が catalog に無い`,
        },
        injected: 0,
      };
    }
    const cfg = resolveServiceInfisical(req.service, source.infisical);
    if (!cfg) {
      return {
        check: {
          kind: 'requires_secret',
          status: 'fail',
          detail: `source service "${req.service}" に infisical 設定が無い`,
        },
        injected: 0,
      };
    }
    try {
      const secrets = await fetchProjectSecrets(id, cfg.project_id, cfg.environment);
      const env = toEnvMap(secrets, { include: req.keys });
      const missing = req.keys.filter((k) => !(k in env));
      if (missing.length > 0) {
        return {
          check: {
            kind: 'requires_secret',
            status: 'fail',
            detail: `"${req.service}" (${cfg.project_id}/${cfg.environment}) に無いキー: ${missing.join(', ')}`,
          },
          injected: Object.keys(env).length,
        };
      }
      injected += Object.keys(env).length;
    } catch (err) {
      return {
        check: {
          kind: 'requires_secret',
          status: 'fail',
          detail: `"${req.service}" fetch 失敗: ${(err as Error).message}`,
        },
        injected: 0,
      };
    }
  }
  return {
    check: { kind: 'requires_secret', status: 'ok', detail: `${requests.length} 件の cross-service secret を解決` },
    injected,
  };
}

function checkPaths(svc: Service): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  if (svc.runtime === 'node' || svc.runtime === 'dev-process-md') {
    if (svc.start_script && !existsSync(svc.start_script)) {
      checks.push({ kind: 'start_script', status: 'fail', detail: `start_script が存在しない: ${svc.start_script}` });
    } else if (svc.start_script) {
      checks.push({ kind: 'start_script', status: 'ok', detail: svc.start_script });
    }
    if (!svc.cwd && !svc.start_script) {
      checks.push({ kind: 'cwd', status: 'fail', detail: 'cwd が未設定' });
    } else if (svc.cwd && !existsSync(svc.cwd)) {
      checks.push({ kind: 'cwd', status: 'fail', detail: `cwd が存在しない: ${svc.cwd}` });
    } else if (svc.cwd) {
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

/** 宣言 port が既に LISTEN されているか (起動済み or foreign 占有) を warn で知らせる。 */
function checkPort(svc: Service, listeners: PortListener[]): PreflightCheck | null {
  if (typeof svc.port !== 'number') return null;
  const l = listeners.find((x) => x.port === svc.port);
  if (!l) return { kind: 'port', status: 'ok', detail: `:${svc.port} 空き` };
  const who = l.processNames.length > 0 ? l.processNames.join(',') : `pid ${l.pids.join(',')}`;
  return {
    kind: 'port',
    status: 'warn',
    detail: `:${svc.port} は既に使用中 (${who}) — 起動済みか別プロセスが占有`,
  };
}

function checkPorts(svc: Service, listeners: PortListener[]): PreflightCheck[] {
  return managedPortsForService(svc).map((p) => {
    const l = listeners.find((x) => x.port === p.port);
    if (!l) return { kind: 'port' as const, status: 'ok' as const, detail: `${p.role} :${p.port} free` };
    const who = l.processNames.length > 0 ? l.processNames.join(',') : `pid ${l.pids.join(',')}`;
    return {
      kind: 'port' as const,
      status: 'warn' as const,
      detail: `${p.role} :${p.port} already in use (${who})`,
    };
  });
}

/** 選択された service を preflight する。 */
export async function runPreflight(services: Service[], codes: string[]): Promise<PreflightReport> {
  const want = new Set(codes);
  const targets = services.filter((s) => want.has(s.code));
  const needsIdentity = targets.some(
    (s) => resolveServiceInfisical(s.code, s.infisical)?.inject || (s.requires_secret?.length ?? 0) > 0,
  );
  const identityPresent = readIdentity() !== null;

  // port 占有は OS 呼び出し 1 回で全 listener を取得して使い回す。
  const listeners = await listListeners();

  const result: ServicePreflight[] = [];
  for (const svc of targets) {
    const checks = checkPaths(svc);
    if (svc.disabled) checks.push({ kind: 'disabled', status: 'fail', detail: 'disabled in catalog' });
    const { check: infCheck, injected } = await checkInfisical(svc);
    checks.push(infCheck);
    const { check: reqSecretCheck, injected: reqSecretInjected } = await checkRequiresSecret(svc);
    checks.push(reqSecretCheck);
    checks.push(await checkRequiredEnv(svc));
    checks.push(...checkPorts(svc, listeners));
    result.push({
      code: svc.code,
      name: svc.name,
      ready: !checks.some((c) => c.status === 'fail'),
      injectedKeys: injected + reqSecretInjected,
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
