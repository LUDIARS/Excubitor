/** @implements SPEC-EX-NETWATCH */
/**
 * OS の接続表 (Windows の `netstat -ano`) を読み、 この PC 側のポートから PID を引く。
 * 見出しや状態名は OS の言語で変わるので、 列の数と形だけで読む (状態の文字列は見ない)。
 * scanner/ports.ts の parseNetstat は LISTENING の TCP だけを拾う (待ち受けポートの占有用) ので使えない。
 * ここでは接続中の TCP (相手アドレスつき) と UDP の全行が要る。
 */

import type { LocalEndpoint } from './types.js';

export interface ConnectionEntry {
  transport: 'tcp' | 'udp';
  localPort: number;
  /** TCP の相手アドレス。 UDP と待ち受け (相手なし) は null。 */
  remote: string | null;
  pid: number;
}

/** `1.2.3.4:443` / `[2001:db8::1%12]:443` / `*:*` を (アドレス, ポート) に分ける。 */
function splitEndpoint(text: string): { address: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  const plain = bracketed ? null : /^([^:]+):(\d+)$/.exec(text);
  const match = bracketed ?? plain;
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { address: match[1]!.replace(/%.*$/, '').toLowerCase(), port };
}

/** 相手が決まっていない (待ち受け) アドレス。 */
function isWildcard(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '*';
}

/** `netstat -ano` の出力を読む。 読めない行 (見出し・空行) は飛ばす。 PID 0 (TIME_WAIT など) は捨てる。 */
export function parseNetstat(text: string): ConnectionEntry[] {
  const entries: ConnectionEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const transport = cols[0]?.toUpperCase();
    // TCP: 種別 自分 相手 状態 PID / UDP: 種別 自分 相手 PID
    const expected = transport === 'TCP' ? 5 : transport === 'UDP' ? 4 : 0;
    if (expected === 0 || cols.length !== expected) continue;
    const pid = Number(cols[cols.length - 1]);
    const local = splitEndpoint(cols[1]!);
    if (!local || !Number.isInteger(pid) || pid <= 0) continue;
    const remote = transport === 'TCP' ? splitEndpoint(cols[2]!) : null;
    entries.push({
      transport: transport === 'TCP' ? 'tcp' : 'udp',
      localPort: local.port,
      remote: remote && !isWildcard(remote.address) ? remote.address : null,
      pid,
    });
  }
  return entries;
}

/** 1 回分の接続表。 自分側ポートから PID を引く。 */
export class ConnectionTable {
  private readonly byPort = new Map<string, ConnectionEntry[]>();

  constructor(entries: ConnectionEntry[]) {
    for (const entry of entries) {
      const key = `${entry.transport}|${entry.localPort}`;
      const list = this.byPort.get(key) ?? [];
      list.push(entry);
      this.byPort.set(key, list);
    }
  }

  /**
   * 自分側ポートと相手から PID を引く。 TCP は相手まで一致するものを優先し、 無ければ
   * そのポートの持ち主が 1 つに決まるときだけ返す (決まらないときは推測しない)。
   */
  ownerOf(local: LocalEndpoint, remote: string): number | null {
    const candidates = this.byPort.get(`${local.transport}|${local.port}`) ?? [];
    const target = remote.toLowerCase();
    const exact = candidates.find((entry) => entry.remote === target);
    if (exact) return exact.pid;
    const pids = new Set(candidates.map((entry) => entry.pid));
    return pids.size === 1 ? [...pids][0]! : null;
  }
}
