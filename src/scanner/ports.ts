/**
 * ポート衝突検知。 catalog が宣言した各サービスの port が
 *   1. catalog 内で重複宣言されていないか (= 同じ port を 2 サービスが取り合う静的衝突)
 *   2. 実際に LISTEN されているか / どの pid が掴んでいるか (= 実行時の占有)
 *   3. サービス停止中なのに port が他プロセスに掴まれていないか (= 起動を妨げる foreign 占有)
 * を検出する。 「ポートの衝突を回避する。 Excubitor が検知できるようにする」 (req5) の実体。
 *
 * OS 依存の列挙だけ exec で行い、 解析 (parse*) は pure にしてテスト可能にする。
 */

import { execCapture } from '../shared/exec.js';
import type { Catalog, Service } from '../catalog/loader.js';
import { managedPortsForService } from '../catalog/ports.js';

export interface PortListener {
  port: number;
  pids: number[];
  processNames: string[];
}

/** catalog 内で同じ port を宣言している複数サービス (静的衝突)。 */
export interface DeclaredConflict {
  port: number;
  codes: string[];
}

/** サービス 1 件の port 占有状況。 */
export interface ServicePortStatus {
  code: string;
  name: string;
  role: string;
  port: number;
  state: string;
  /** port が LISTEN されているか。 */
  listening: boolean;
  pids: number[];
  processNames: string[];
  /**
   * サービスが動いている (running) のに掴んでいる = 正常占有。
   * 停止中 (stopped/crashed/unknown) なのに掴まれている = foreign 占有 (起動を妨げる)。
   */
  conflict: boolean;
}

export interface PortReport {
  /** 現在 LISTEN 中の全 port → pid。 */
  listeners: PortListener[];
  /** catalog 内の port 重複宣言。 */
  declaredConflicts: DeclaredConflict[];
  /** port を宣言した各サービスの占有状況。 */
  services: ServicePortStatus[];
  /** foreign 占有が 1 つでもあるか。 */
  hasConflict: boolean;
}

/**
 * `netstat -ano` (Windows) の出力を {port, pid}[] に解析する。
 * LISTENING 行のみ拾い、 ローカルアドレス末尾の :port と pid を取る。
 */
export function parseNetstat(stdout: string): Array<{ port: number; pid: number }> {
  const out: Array<{ port: number; pid: number }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('TCP')) continue;
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // TCP  <local>  <remote>  LISTENING  <pid>
    const local = cols[1];
    const pidStr = cols[cols.length - 1];
    if (!local || !pidStr) continue;
    const portMatch = local.match(/:(\d+)$/);
    const pid = Number(pidStr);
    if (!portMatch || !Number.isFinite(pid)) continue;
    const port = Number(portMatch[1]);
    if (Number.isFinite(port)) out.push({ port, pid });
  }
  return out;
}

/**
 * `ss -ltnH` (Linux) の出力を {port, pid}[] に解析する。
 * 末尾の users:(("name",pid=NNN,...)) から pid を取る。
 */
export function parseSs(stdout: string): Array<{ port: number; pid: number }> {
  const out: Array<{ port: number; pid: number }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    const localIdx = 3; // State Recv-Q Send-Q Local:Port ...
    const local = cols[localIdx];
    if (!local) continue;
    const portMatch = local.match(/:(\d+)$/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    const pidMatch = line.match(/pid=(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : -1;
    if (Number.isFinite(port)) out.push({ port, pid });
  }
  return out;
}

/** `tasklist /fo csv /nh` (Windows) を pid→name に解析する。 */
export function parseTasklist(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    // "name.exe","PID","Session","#","Mem"
    const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
    const name = cols[0];
    const pid = Number(cols[1]);
    if (name && Number.isFinite(pid)) map.set(pid, name);
  }
  return map;
}

/** 現在 LISTEN している port → pid を OS から取得する。 */
async function rawListeners(): Promise<Array<{ port: number; pid: number }>> {
  if (process.platform === 'win32') {
    const r = await execCapture('netstat', ['-ano', '-p', 'TCP'], process.cwd(), 10000);
    return r.ok ? parseNetstat(r.stdout) : [];
  }
  const r = await execCapture('ss', ['-ltnH'], process.cwd(), 10000);
  return r.ok ? parseSs(r.stdout) : [];
}

/** pid 群の実行ファイル名を取得する (Windows=tasklist、 POSIX は省略)。 */
async function processNamesFor(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0 || process.platform !== 'win32') return new Map();
  const r = await execCapture('tasklist', ['/fo', 'csv', '/nh'], process.cwd(), 10000);
  if (!r.ok) return new Map();
  const all = parseTasklist(r.stdout);
  const filtered = new Map<number, string>();
  for (const pid of pids) {
    const name = all.get(pid);
    if (name) filtered.set(pid, name);
  }
  return filtered;
}

/** LISTEN 中の port → {pids, names} を集約する。 */
export async function listListeners(): Promise<PortListener[]> {
  const raw = await rawListeners();
  const byPort = new Map<number, Set<number>>();
  for (const { port, pid } of raw) {
    if (!byPort.has(port)) byPort.set(port, new Set());
    if (pid > 0) byPort.get(port)!.add(pid);
  }
  const allPids = [...new Set(raw.map((r) => r.pid).filter((p) => p > 0))];
  const names = await processNamesFor(allPids);
  return [...byPort.entries()]
    .map(([port, pids]) => ({
      port,
      pids: [...pids],
      processNames: [...pids].map((p) => names.get(p)).filter((n): n is string => !!n),
    }))
    .sort((a, b) => a.port - b.port);
}

/** catalog 内で port を宣言している (port を持つ) 対象サービスを抽出する。 */
function portfulServices(catalog: Catalog): Service[] {
  return catalog.services.filter((s) => managedPortsForService(s).length > 0);
}

function isDevelopPair(a: Service, b: Service): boolean {
  if (!a.project_code || a.project_code !== b.project_code) return false;
  return (a.develop_derived && a.develop_from === b.code)
    || (b.develop_derived && b.develop_from === a.code);
}

interface PortDeclaration {
  svc: Service;
  role: string;
}

function declarationsByPort(catalog: Catalog): Map<number, PortDeclaration[]> {
  const byPort = new Map<number, PortDeclaration[]>();
  for (const svc of portfulServices(catalog)) {
    for (const managed of managedPortsForService(svc)) {
      const list = byPort.get(managed.port) ?? [];
      list.push({ svc, role: managed.role });
      byPort.set(managed.port, list);
    }
  }
  return byPort;
}

/** catalog 内の port 重複宣言を検出する。正規の main/develop ペアだけは除外する。 */
export function detectDeclaredConflicts(catalog: Catalog): DeclaredConflict[] {
  return [...declarationsByPort(catalog).entries()]
    .map(([port, declarations]) => {
      const conflicting = declarations.filter((current, index) => declarations.some(
        (other, otherIndex) => index !== otherIndex && !isDevelopPair(current.svc, other.svc),
      ));
      return { port, codes: conflicting.map(({ svc, role }) => `${svc.code}:${role}`) };
    })
    .filter(({ codes }) => codes.length > 1)
    .sort((a, b) => a.port - b.port);
}

/** LISTEN 中の同一 port で main/develop ペアが共に running なら両方を異常扱いする。 */
export function detectConcurrentDevelopConflicts(
  catalog: Catalog,
  stateByCode: Map<string, string>,
  listeningPorts: Set<number>,
): Set<string> {
  const conflicts = new Set<string>();
  for (const [port, declarations] of declarationsByPort(catalog)) {
    if (!listeningPorts.has(port)) continue;
    for (let i = 0; i < declarations.length; i += 1) {
      for (let j = i + 1; j < declarations.length; j += 1) {
        const a = declarations[i];
        const b = declarations[j];
        if (!a || !b || !isDevelopPair(a.svc, b.svc)) continue;
        if (stateByCode.get(a.svc.code) !== 'running' || stateByCode.get(b.svc.code) !== 'running') continue;
        conflicts.add(`${a.svc.code}:${a.role}`);
        conflicts.add(`${b.svc.code}:${b.role}`);
      }
    }
  }
  return conflicts;
}

/**
 * catalog の port 占有状況レポートを作る。
 * @param stateByCode service code → state ('running' | 'stopped' | 'crashed' | 'unknown')
 */
export async function buildPortReport(
  catalog: Catalog,
  stateByCode: Map<string, string>,
): Promise<PortReport> {
  const listeners = await listListeners();
  const byPort = new Map(listeners.map((l) => [l.port, l]));
  const concurrentDevelopConflicts = detectConcurrentDevelopConflicts(
    catalog,
    stateByCode,
    new Set(listeners.map((listener) => listener.port)),
  );

  const services: ServicePortStatus[] = portfulServices(catalog).flatMap((s) => managedPortsForService(s).map((p) => {
    const l = byPort.get(p.port);
    const state = stateByCode.get(s.code) ?? 'unknown';
    const listening = !!l;
    // 起動中サービスが port を掴んでいる = 正常。 停止中なのに掴まれている = foreign 占有。
    const conflict = listening && (state !== 'running' || concurrentDevelopConflicts.has(`${s.code}:${p.role}`));
    return {
      code: s.code,
      name: s.name,
      role: p.role,
      port: p.port,
      state,
      listening,
      pids: l?.pids ?? [],
      processNames: l?.processNames ?? [],
      conflict,
    };
  }));

  return {
    listeners,
    declaredConflicts: detectDeclaredConflicts(catalog),
    services,
    hasConflict: services.some((s) => s.conflict),
  };
}

/** 単一 port が foreign プロセスに占有されているかを判定する (preflight / 起動前ガード用)。 */
export async function portOccupiedByForeign(
  port: number,
  serviceState: string,
): Promise<{ occupied: boolean; pids: number[]; processNames: string[] }> {
  const listeners = await listListeners();
  const l = listeners.find((x) => x.port === port);
  if (!l) return { occupied: false, pids: [], processNames: [] };
  return { occupied: serviceState !== 'running', pids: l.pids, processNames: l.processNames };
}
