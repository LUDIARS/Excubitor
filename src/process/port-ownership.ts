/**
 * 宣言ポートを「いま誰が握っているか」をサービス状態の一部として判定する。
 *
 * SRP: 判定だけ。 リスナー列挙は scanner/ports.ts、 停止は process/port-guard.ts、
 * API への載せ方は index.ts が持つ。
 *
 * なぜ必要か: 2026-08-08、 Concordia の再起動が失敗した後も旧プロセス (別日に起動) が
 * port 11111 を握って health 200 を返し続け、 Excubitor 上は state=crashed なのに
 * health_ok=true という状態になった。 どちらの数字も単体では嘘ではないので、 見た人は
 * 「crashed だが生きている」としか読めず、 実体が管理外であることに気づけない。
 *
 * health は「その port の向こうに誰かが居る」ことしか言わない。 それが Excubitor が
 * 起動したプロセスかどうかは別の事実で、 ここで突き合わせる。
 */

import type { PortListener } from '../scanner/ports.js';

export type PortOwner =
  /** Excubitor が起動した pid が握っている。 */
  | 'managed'
  /** 誰かが握っているが Excubitor の管理下ではない (取りこぼした旧インスタンス等)。 */
  | 'unmanaged'
  /** 誰も握っていない。 */
  | 'free'
  /** ローカルで判定できない (remote host / docker / port 未宣言)。 */
  | 'unknown';

export interface PortOwnershipInput {
  /** catalog が宣言した port。 未宣言なら null。 */
  port: number | null | undefined;
  /** Excubitor が把握している当該サービスの pid。 無ければ undefined。 */
  managedPid: number | undefined;
  /** 現在のリスナー一覧 (ローカルホストのもの)。 */
  listeners: readonly PortListener[];
  /** 直近の health プローブ結果。 未計測なら null。 */
  healthOk: boolean | null;
  /** ローカルホストで動く想定のサービスか (remote / docker なら false)。 */
  local: boolean;
}

export interface PortOwnership {
  owner: PortOwner;
  /** 実際に握っている pid (owner が managed / unmanaged のときのみ)。 */
  holderPids: number[];
  /**
   * health_ok をそのまま「このサービスが健全」と読んでよいか。
   *
   * false になるのは 2 通り。 どちらも health の数字自体は正しく、 意味づけだけが
   * 間違っている状態:
   * - 管理外プロセスが応答している (再起動したつもりで旧コードが動き続ける)
   * - 誰も LISTEN していないのに直近の health が ok (計測が古い)
   */
  healthTrusted: boolean;
  /** 判定の根拠。 UI とログにそのまま出す。 */
  reason: string | null;
}

export function classifyPortOwnership(input: PortOwnershipInput): PortOwnership {
  const trusted = (owner: PortOwner): PortOwnership =>
    ({ owner, holderPids: [], healthTrusted: true, reason: null });

  if (!input.local) return trusted('unknown');
  if (input.port == null) return trusted('unknown');

  const listener = input.listeners.find((entry) => entry.port === input.port);
  const holderPids = listener ? [...listener.pids] : [];

  if (holderPids.length === 0) {
    // 誰も居ないのに health が ok を主張しているなら、 その ok は過去の観測。
    return {
      owner: 'free',
      holderPids: [],
      healthTrusted: input.healthOk !== true,
      reason: input.healthOk === true
        ? `health は ok だが port ${input.port} を LISTEN しているプロセスが無い (観測が古い)`
        : null,
    };
  }

  if (input.managedPid !== undefined && holderPids.includes(input.managedPid)) {
    return { owner: 'managed', holderPids, healthTrusted: true, reason: null };
  }

  return {
    owner: 'unmanaged',
    holderPids,
    healthTrusted: false,
    reason: `port ${input.port} を管理外のプロセス (pid=${holderPids.join(', ')}) が握っている`
      + (input.managedPid === undefined
        ? ' — Excubitor はこのサービスの pid を把握していない'
        : ` — Excubitor が把握している pid は ${input.managedPid}`),
  };
}
