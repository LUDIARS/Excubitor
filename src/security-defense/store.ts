import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { jstDay } from './dates.js';
import type { NetworkEvidence, NetworkEvidenceRow } from './network-evidence.js';

export interface CountRow { service: string; reason: string; action: string; status: number; count: number }
export interface FindingRow { rule: string; asset: string; count: number; firstAt: number; lastAt: number }
export interface CoverageRow { source: string; state: string; count: number; firstAt: number; lastAt: number }
export interface DayData { day: string; counts: CountRow[]; findings: FindingRow[]; coverage: CoverageRow[]; metrics: { name: string; value: number }[]; network?: NetworkEvidenceRow[] }
export interface SavedReport { day: string; delivery: string; body: string }

/** Durable bounded aggregates and attempt-before-send delivery state. No raw request data. */
export class DefenseStore {
  private readonly db: Database.Database;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS defense_counts(day TEXT,service TEXT,reason TEXT,action TEXT,status INTEGER,count INTEGER,
        PRIMARY KEY(day,service,reason,action,status));
      CREATE TABLE IF NOT EXISTS defense_findings(day TEXT,rule TEXT,asset TEXT,count INTEGER,firstAt INTEGER,lastAt INTEGER,
        PRIMARY KEY(day,rule,asset));
      CREATE TABLE IF NOT EXISTS defense_coverage(day TEXT,source TEXT,state TEXT,count INTEGER,firstAt INTEGER,lastAt INTEGER,
        PRIMARY KEY(day,source,state));
      CREATE TABLE IF NOT EXISTS defense_reports(day TEXT PRIMARY KEY,delivery TEXT,body TEXT);
      CREATE TABLE IF NOT EXISTS defense_state(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS defense_metrics(day TEXT,name TEXT,value INTEGER,PRIMARY KEY(day,name));
      CREATE TABLE IF NOT EXISTS defense_network(day TEXT,ip TEXT,detail TEXT,count INTEGER,firstAt INTEGER,lastAt INTEGER,firstSeenAt INTEGER,lastSeenAt INTEGER,
        PRIMARY KEY(day,ip,detail));
    `);
    } catch (error) { this.db.close(); throw error; }
  }
  metric(at: number, name: string, value: number): void {
    const size = this.db.prepare('SELECT count(*) AS n FROM defense_metrics WHERE day=?').get(jstDay(at)) as { n: number };
    if (size.n >= 1000) name = 'metric_capacity_overflow';
    this.db.prepare('INSERT INTO defense_metrics VALUES(?,?,?) ON CONFLICT(day,name) DO UPDATE SET value=value+excluded.value').run(jstDay(at), name, value);
  }
  network(at: number, evidence: NetworkEvidence): void {
    const day = jstDay(at);
    const { firstSeenAt, lastSeenAt, ...metadata } = evidence;
    const detail = JSON.stringify(metadata);
    const existing = this.db.prepare('SELECT 1 FROM defense_network WHERE day=? AND ip=? AND detail=?').get(day, evidence.ip, detail);
    const size = this.db.prepare('SELECT count(*) AS n FROM defense_network WHERE day=?').get(day) as { n: number };
    if (!existing && size.n >= 1000) { this.coverage(at, 'network_evidence', 'capacity'); return; }
    this.db.prepare(`INSERT INTO defense_network VALUES(?,?,?,1,?,?,?,?) ON CONFLICT(day,ip,detail)
      DO UPDATE SET count=count+1,lastAt=excluded.lastAt,firstSeenAt=MIN(firstSeenAt,excluded.firstSeenAt),lastSeenAt=MAX(lastSeenAt,excluded.lastSeenAt)`)
      .run(day, evidence.ip, detail, at, at, firstSeenAt, lastSeenAt);
  }
  networkRows(day: string): NetworkEvidenceRow[] {
    const rows = this.db.prepare('SELECT detail,count,firstAt,lastAt,firstSeenAt,lastSeenAt FROM defense_network WHERE day=? ORDER BY lastAt DESC').all(day) as
      { detail: string; count: number; firstAt: number; lastAt: number; firstSeenAt: number; lastSeenAt: number }[];
    return rows.map(({ detail, ...row }) => ({ ...JSON.parse(detail) as NetworkEvidence, ...row }));
  }
  count(at: number, service: string, reason: string, action: string, status: number): void {
    this.db.prepare(`INSERT INTO defense_counts VALUES(?,?,?,?,?,1) ON CONFLICT(day,service,reason,action,status)
      DO UPDATE SET count=count+1`).run(jstDay(at), service, reason, action, status);
  }
  finding(at: number, rule: string, asset: string): void {
    const day = jstDay(at);
    const size = this.db.prepare('SELECT count(*) AS n FROM defense_findings WHERE day=?').get(day) as { n: number };
    // Overflow remains visible without admitting attacker-controlled cardinality.
    if (size.n >= 1000) { rule = 'finding_capacity'; asset = 'overflow'; }
    this.db.prepare(`INSERT INTO defense_findings VALUES(?,?,?,1,?,?) ON CONFLICT(day,rule,asset)
      DO UPDATE SET count=count+1,lastAt=excluded.lastAt`).run(day, rule, asset, at, at);
  }
  coverage(at: number, source: string, state: string): void {
    this.db.prepare(`INSERT INTO defense_coverage VALUES(?,?,?,1,?,?) ON CONFLICT(day,source,state)
      DO UPDATE SET count=count+1,lastAt=excluded.lastAt`).run(jstDay(at), source, state, at, at);
  }
  data(day: string): DayData {
    return { day,
      network: this.networkRows(day),
      counts: this.db.prepare('SELECT service,reason,action,status,count FROM defense_counts WHERE day=? ORDER BY count DESC').all(day) as CountRow[],
      findings: this.db.prepare('SELECT rule,asset,count,firstAt,lastAt FROM defense_findings WHERE day=? ORDER BY lastAt DESC').all(day) as FindingRow[],
      coverage: this.db.prepare('SELECT source,state,count,firstAt,lastAt FROM defense_coverage WHERE day=?').all(day) as CoverageRow[],
      metrics: this.db.prepare('SELECT name,value FROM defense_metrics WHERE day=? ORDER BY value DESC').all(day) as { name: string; value: number }[],
    };
  }
  state(key: string): string | null {
    return (this.db.prepare('SELECT value FROM defense_state WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO defense_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  claimReport(day: string, body: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO defense_reports VALUES(?, ?, ?)').run(day, 'attempted_unknown', body).changes === 1;
  }
  delivered(day: string): void { this.db.prepare("UPDATE defense_reports SET delivery='sent' WHERE day=?").run(day); }
  reports(): SavedReport[] { return this.db.prepare('SELECT * FROM defense_reports ORDER BY day DESC LIMIT 30').all() as SavedReport[]; }
  prune(now: number): void {
    const before = jstDay(now - 90 * 86400000);
    for (const table of ['defense_counts', 'defense_findings', 'defense_coverage', 'defense_reports', 'defense_metrics', 'defense_network']) {
      this.db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(before);
    }
  }
  close(): void { this.db.close(); }
}
