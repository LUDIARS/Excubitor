/** @implements SPEC-EX-DNS-FILTER */
/**
 * 直近の問い合わせ (上限件数の輪) と件数。 メモリだけに置き、 ファイルにも DB にも残さない
 * (どの名前を引いたかは閲覧履歴に近いので、 見える範囲を Excubitor の画面と API に限る)。
 */

export type QueryAction = 'allowed' | 'blocked' | 'failed' | 'refused';

export interface QueryRecord {
  atMs: number;
  client: string;
  transport: 'udp' | 'tcp';
  name: string;
  type: string;
  action: QueryAction;
  /** 当たった規則 (ドメイン) と出どころ。 */
  rule: string | null;
  source: string | null;
  /** 応答の RCODE (返さなかったときは null)。 */
  rcode: number | null;
  /** 失敗の理由。 */
  detail: string | null;
  elapsedMs: number;
}

export interface QueryCounters {
  total: number;
  allowed: number;
  blocked: number;
  failed: number;
  /** 範囲外の相手からの問い合わせ (答えずに捨てた)。 輪には入れない。 */
  refused: number;
  /** 読めない問い合わせ。 */
  malformed: number;
}

export class QueryLog {
  private readonly records: QueryRecord[] = [];
  private next = 0;
  readonly counters: QueryCounters = { total: 0, allowed: 0, blocked: 0, failed: 0, refused: 0, malformed: 0 };

  constructor(private capacity: number) {}

  /** 上限を変える。 小さくしたら古いものから捨てる。 */
  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    const kept = this.recent(capacity);
    this.records.length = 0;
    this.records.push(...kept.reverse());
    this.next = this.records.length % capacity;
    this.capacity = capacity;
  }

  add(record: QueryRecord): void {
    this.counters.total += 1;
    this.counters[record.action] += 1;
    if (this.records.length < this.capacity) {
      this.records.push(record);
    } else {
      this.records[this.next] = record;
    }
    this.next = (this.next + 1) % this.capacity;
  }

  /** 輪に入れない出来事を数える。 */
  count(kind: 'refused' | 'malformed'): void {
    this.counters.total += 1;
    this.counters[kind] += 1;
  }

  /** 新しい順に最大 limit 件。 */
  recent(limit: number, filter?: (record: QueryRecord) => boolean): QueryRecord[] {
    const ordered: QueryRecord[] = [];
    const size = this.records.length;
    for (let index = 1; index <= size && ordered.length < limit; index += 1) {
      const record = this.records[(this.next - index + size * 2) % size]!;
      if (!filter || filter(record)) ordered.push(record);
    }
    return ordered;
  }
}
