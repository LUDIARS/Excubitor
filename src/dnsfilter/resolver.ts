/** @implements SPEC-EX-DNS-FILTER */
/**
 * 問い合わせ 1 件の処理。 相手の範囲を確かめ、 名前を規則で判定し、 止める名前には NXDOMAIN を返し、
 * それ以外は上流へ中継する。 上流の応答は問い合わせと同じ質問への応答であることを確かめてから返し、
 * 解決したアドレスを netwatch の名前付けへ渡す。
 */

import {
  buildHeaderOnlyResponse, buildResponse, parseQuery, parseUpstreamResponse, RCODE, typeName, type Rcode,
} from './dns-message.js';
import { decide, type RuleBook } from './domain-rules.js';
import type { ClientPolicy } from './client-policy.js';
import type { QueryAction, QueryLog } from './query-log.js';
import type { Forwarder, Transport } from './upstream.js';

/** 標準の問い合わせ (QUERY) 以外は中継しない。 */
const OPCODE_QUERY = 0;

export interface ResolvedAnswer {
  name: string;
  addresses: string[];
}

export interface ResolverDeps {
  rules: () => RuleBook;
  clients: ClientPolicy;
  forward: Forwarder;
  log: QueryLog;
  maxInFlight: number;
  now: () => number;
  /** 解決できたアドレス (netwatch の名前付け用)。 */
  onAnswer?: (answer: ResolvedAnswer) => void;
}

export interface ClientInfo {
  address: string;
  transport: Transport;
}

export class DnsFilterResolver {
  private inFlight = 0;

  constructor(private readonly deps: ResolverDeps) {}

  get pending(): number {
    return this.inFlight;
  }

  /** 応答を返す。 答えない (範囲外の相手・ヘッダも読めない) ときは null。 */
  async handle(packet: Buffer, client: ClientInfo): Promise<Buffer | null> {
    const { log, now } = this.deps;
    if (!this.deps.clients.allows(client.address)) {
      log.count('refused');
      return null;
    }
    const parsed = parseQuery(packet);
    if (!parsed.ok) {
      log.count('malformed');
      return parsed.id === null ? null : buildHeaderOnlyResponse(parsed.id, RCODE.FORMERR);
    }
    const { query } = parsed;
    const startedMs = now();
    const record = (action: QueryAction, rcode: Rcode | number | null, extra: { rule?: string | null; source?: string | null; detail?: string | null } = {}): void => {
      log.add({
        atMs: startedMs,
        client: client.address,
        transport: client.transport,
        name: query.name,
        type: typeName(query.type),
        action,
        rule: extra.rule ?? null,
        source: extra.source ?? null,
        rcode,
        detail: extra.detail ?? null,
        elapsedMs: now() - startedMs,
      });
    };

    if (query.opcode !== OPCODE_QUERY) {
      record('failed', RCODE.NOTIMP, { detail: `opcode ${query.opcode} は中継しない` });
      return buildResponse(packet, query, RCODE.NOTIMP);
    }
    const decision = decide(query.name, this.deps.rules());
    if (decision.action === 'block') {
      record('blocked', RCODE.NXDOMAIN, { rule: decision.rule, source: decision.source });
      return buildResponse(packet, query, RCODE.NXDOMAIN);
    }
    if (this.inFlight >= this.deps.maxInFlight) {
      record('failed', RCODE.SERVFAIL, { detail: `同時に中継できる ${this.deps.maxInFlight} 件を超えた` });
      return buildResponse(packet, query, RCODE.SERVFAIL);
    }
    this.inFlight += 1;
    try {
      const response = await this.deps.forward(packet, client.transport);
      const answer = parseUpstreamResponse(response, query);
      if (!answer.ok) {
        record('failed', RCODE.SERVFAIL, { detail: `上流の応答が不正: ${answer.reason}` });
        return buildResponse(packet, query, RCODE.SERVFAIL);
      }
      record('allowed', answer.answer.rcode, { rule: decision.rule, source: decision.source });
      if (answer.answer.rcode === RCODE.NOERROR && answer.answer.addresses.length > 0) {
        this.deps.onAnswer?.({ name: query.name, addresses: answer.answer.addresses });
      }
      return response;
    } catch (error) {
      record('failed', RCODE.SERVFAIL, { detail: (error as Error).message });
      return buildResponse(packet, query, RCODE.SERVFAIL);
    } finally {
      this.inFlight -= 1;
    }
  }
}
