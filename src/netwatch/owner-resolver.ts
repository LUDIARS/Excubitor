/** @implements SPEC-EX-NETWATCH */
/**
 * PID を「通信を出したプロセス」にする。 実行ファイル名はプロセス一覧 (process-snapshot) から、
 * サービスかどうかは Excubitor が起動したサービスの PID を根に親をたどって決める。
 * 一覧に無い PID は名前もサービスも不明のまま返す (推測しない)。
 */

import type { TrafficOwner } from './types.js';

export interface ProcessRow {
  pid: number;
  ppid: number;
  name?: string;
}

/** Excubitor が起動・採用したサービスの根プロセス。 */
export interface ServiceRoot {
  code: string;
  pid: number;
}

/** 親をたどる上限 (循環や異常に深い木で止める)。 */
const MAX_ANCESTRY_DEPTH = 64;

export class OwnerResolver {
  private readonly rows = new Map<number, ProcessRow>();
  private readonly roots = new Map<number, string>();

  constructor(processes: readonly ProcessRow[], roots: readonly ServiceRoot[]) {
    for (const row of processes) this.rows.set(row.pid, row);
    for (const root of roots) this.roots.set(root.pid, root.code);
  }

  resolve(pid: number): TrafficOwner {
    return { pid, name: this.rows.get(pid)?.name ?? null, service: this.serviceOf(pid) };
  }

  /** pid か、 その祖先がサービスの根ならその code。 */
  private serviceOf(pid: number): string | null {
    let current: number | undefined = pid;
    const visited = new Set<number>();
    for (let depth = 0; current !== undefined && depth < MAX_ANCESTRY_DEPTH; depth += 1) {
      const code = this.roots.get(current);
      if (code) return code;
      if (visited.has(current)) return null;
      visited.add(current);
      const row = this.rows.get(current);
      if (!row || row.ppid === current) return null;
      current = row.ppid;
    }
    return null;
  }
}
