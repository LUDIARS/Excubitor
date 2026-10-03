/**
 * 起動前チェック (preflight)。 起動セットの各サービスについて、 起動に必要な前提が
 * 揃っているかを spawn 前に検査する:
 *   - cwd / compose_file の実在
 *   - Vault binding の解決可否と必須 env の不足
 *
 * 「事前に起動チェックする」 (2026-06-04 ユーザ指示) の実体。 NG があっても throw せず
 * レポートで返し、 UI / orchestrator が判断する。
 */

import { existsSync } from 'node:fs';
import type { Service } from '../catalog/loader.js';
import { listListeners, type PortListener } from '../scanner/ports.js';
import { managedPortsForService } from '../catalog/ports.js';
import { resolveInjectEnv } from '../process/inject.js';
import { validateStartupEnv } from '../process/startup-env.js';
import { needsWorkingDirectory } from '../catalog/runtime-kind.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  kind: 'cwd' | 'compose_file' | 'vault' | 'requires_secret' | 'env' | 'start_script' | 'port' | 'disabled';
  status: CheckStatus;
  detail: string;
}

export interface ServicePreflight {
  code: string;
  name: string;
  ready: boolean; // fail が 1 つも無い
  injectedKeys: number; // 解決した注入 env 全体のキー数
  checks: PreflightCheck[];
}

export interface PreflightReport {
  ok: boolean; // 全サービス ready
  identityPresent: boolean;
  needsIdentity: boolean; // Compatibility field; always false for Vault-only runtime.
  services: ServicePreflight[];
}

/** Resolve once so peer fetch and required-env checks use the same snapshot. */
async function checkVaultEnv(svc: Service): Promise<{ checks: PreflightCheck[]; injected: number }> {
  try {
    const env = await resolveInjectEnv(svc);
    const validation = validateStartupEnv(svc, env);
    return {
      checks: [
        { kind: 'vault', status: 'ok', detail: 'Vault-only environment resolved' },
        {
          kind: 'env', status: validation.ready ? 'ok' : 'fail',
          detail: validation.ready
            ? validation.required.length + ' required env present'
            : 'missing required env: ' + validation.missing.join(', '),
        },
      ],
      injected: Object.keys(env).length,
    };
  } catch (error) {
    return { checks: [{ kind: 'vault', status: 'fail', detail: (error as Error).message }], injected: 0 };
  }
}

function checkPaths(svc: Service): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  if (needsWorkingDirectory(svc.runtime)) {
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
  // Compatibility fields: Infisical identity is no longer consulted.
  const needsIdentity = false;
  const identityPresent = false;

  // port 占有は OS 呼び出し 1 回で全 listener を取得して使い回す。
  const listeners = await listListeners();

  const result: ServicePreflight[] = [];
  for (const svc of targets) {
    const checks = checkPaths(svc);
    if (svc.disabled) checks.push({ kind: 'disabled', status: 'fail', detail: 'disabled in catalog' });
    const resolved = await checkVaultEnv(svc);
    checks.push(...resolved.checks);
    checks.push(...checkPorts(svc, listeners));
    result.push({
      code: svc.code,
      name: svc.name,
      ready: !checks.some((c) => c.status === 'fail'),
      injectedKeys: resolved.injected,
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
