import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { reportInput, serviceCode, storedReport, type ReportInput, type SecurityReport } from './schema.js';

/** Append-only local records; service codes never become arbitrary filesystem paths.
 * @implements SPEC-EX-SECURITY-REPORTS */
export class SecurityReportStore {
  constructor(private readonly root: string, private readonly now = () => new Date()) {}
  save(code: string, input: ReportInput): SecurityReport {
    serviceCode.parse(code);
    const report = { ...reportInput.parse(input), id: randomUUID(), service: code,
      recordedAt: this.now().toISOString() };
    const folder = join(this.root, code);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = report.recordedAt.replaceAll(':', '-') + '-' + report.id + '.json';
    const text = JSON.stringify(report);
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('report size limit');
    const pending = join(folder, file + '.tmp');
    try {
      writeFileSync(pending, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(pending, join(folder, file));
    } finally {
      try { unlinkSync(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return report;
  }
  latest(code: string): SecurityReport | null {
    serviceCode.parse(code);
    const folder = join(this.root, code);
    let files: string[];
    try { files = readdirSync(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const file = files.filter(f => /^\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]+\.json$/.test(f)).sort().at(-1);
    if (!file) return null;
    const path = join(folder, file);
    if (statSync(path).size > 1024 * 1024) throw new Error('report size limit');
    const result = storedReport.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (result.service !== code) throw new Error('report service mismatch');
    return result;
  }
}
