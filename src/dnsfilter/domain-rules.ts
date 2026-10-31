/** @implements SPEC-EX-DNS-FILTER */
/**
 * ドメインの規則。 規則はそのドメインと配下すべてに当たる (`example.com` は `a.example.com` も)。
 * 許可が拒否より優先する。 拒否の出どころは API で足した規則・config の固定・既知の DoH の 3 つ。
 */

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const MAX_DOMAIN_LENGTH = 253;

/**
 * 既知の DoH / 暗号化 DNS の入口。 ここへの名前解決を止めると、 ブラウザや OS が自前の暗号化 DNS へ
 * 逃げずにこのフィルタを使う。 `use-application-dns.net` は Firefox の canary (NXDOMAIN で既定の DoH を切る)、
 * `mask.icloud.com` / `mask-h2.icloud.com` は iCloud プライベートリレーの canary (同じく切る)。
 */
export const KNOWN_DOH_DOMAINS = [
  'use-application-dns.net',
  'mask.icloud.com', 'mask-h2.icloud.com',
  'dns.google', 'cloudflare-dns.com', 'dns.quad9.net', 'doh.opendns.com',
  'dns.adguard-dns.com', 'dns.nextdns.io', 'doh.cleanbrowsing.org', 'doh.mullvad.net', 'dns.controld.com',
];

export type RuleSource = 'api' | 'config' | 'doh';

export type DomainParse = { ok: true; domain: string } | { ok: false; reason: string };

/** 規則のドメインを正規化する (小文字、 前の `*.` と後ろの `.` を外す)。 */
export function normalizeDomain(input: string): DomainParse {
  let text = input.trim().toLowerCase();
  if (text.startsWith('*.')) text = text.slice(2);
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (text.length === 0) return { ok: false, reason: 'ドメインが空' };
  if (text.length > MAX_DOMAIN_LENGTH) return { ok: false, reason: `ドメインは ${MAX_DOMAIN_LENGTH} 文字まで` };
  const labels = text.split('.');
  if (!labels.every((label) => LABEL.test(label))) {
    return { ok: false, reason: 'ドメインとして読めない (英数字・ハイフン・下線のラベルを . でつなぐ。 日本語ドメインは xn-- 形式で)' };
  }
  return { ok: true, domain: text };
}

/** ドメインの集合。 名前の親を順に辿って、 当たった規則のドメインを返す。 */
export class DomainSet {
  private readonly domains = new Set<string>();

  constructor(domains: Iterable<string> = []) {
    for (const domain of domains) this.domains.add(domain);
  }

  get size(): number {
    return this.domains.size;
  }

  /** 名前 (小文字・末尾の点なし) に当たる規則。 無ければ null。 */
  match(name: string): string | null {
    let candidate = name;
    for (;;) {
      if (this.domains.has(candidate)) return candidate;
      const dot = candidate.indexOf('.');
      if (dot < 0) return null;
      candidate = candidate.slice(dot + 1);
    }
  }
}

export type Decision =
  | { action: 'allow'; rule: string | null; source: 'allowlist' | null }
  | { action: 'block'; rule: string; source: RuleSource };

export interface RuleBook {
  allowed: DomainSet;
  /** 出どころ順 (API → config → DoH) に見る。 */
  blocked: ReadonlyArray<{ source: RuleSource; set: DomainSet }>;
}

/** 名前を判定する。 許可に当たれば通し、 そうでなければ拒否の規則を順に見る。 */
export function decide(name: string, book: RuleBook): Decision {
  const allowed = book.allowed.match(name);
  if (allowed !== null) return { action: 'allow', rule: allowed, source: 'allowlist' };
  for (const { source, set } of book.blocked) {
    const rule = set.match(name);
    if (rule !== null) return { action: 'block', rule, source };
  }
  return { action: 'allow', rule: null, source: null };
}

/** config の一覧を正規化する。 読めないものは設定エラーとして投げる。 */
export function normalizeDomainList(key: string, values: readonly string[]): string[] {
  return values.map((value) => {
    const parsed = normalizeDomain(value);
    if (!parsed.ok) throw new Error(`${key}: ${value}: ${parsed.reason}`);
    return parsed.domain;
  });
}
