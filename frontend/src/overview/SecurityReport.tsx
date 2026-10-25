import { useEffect, useState } from 'react';

type Section = { status: 'reviewed' | 'findings' | 'unverified'; summary: string; details: string };
type Report = { id: string; service: string; observedAt: string; recordedAt: string; author: string; scope: string;
  dependencies: Section; communications: Section; vulnerabilities: Section; coverage: Section };
const labels = { reviewed: '確認済み（安全保証ではありません）', findings: '確認すべき点あり', unverified: '未確認・調査途中' };
const sections = [['dependencies', '依存パッケージ'], ['communications', '通信'], ['vulnerabilities', '脆弱性'], ['coverage', '調査範囲・限界']] as const;

/** @implements SPEC-EX-SECURITY-REPORTS */
export default function SecurityReport({ code }: { code: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState('記録を読み込んでいます。');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setMessage('記録を読み込んでいます。');
    void fetch(`/api/v1/services/${encodeURIComponent(code)}/security-report`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => { if (!r.ok) throw new Error('read failed'); return r.json() as Promise<{ report: Report | null }>; })
      .then(data => { if (!controller.signal.aborted) { setReport(data.report); setMessage(data.report ? '' : '調査記録はまだありません。安全確認済みという意味ではありません。'); } })
      .catch(() => { if (!controller.signal.aborted) setMessage('調査記録を取得できません。'); });
    return () => controller.abort();
  }, [code, revision]);
  return <section className="ex-settings" aria-label="セキュリティ調査">
    <h3>セキュリティ調査</h3><button onClick={() => setRevision(value => value + 1)}>記録を再読み込み</button>
    {message && <p role="status">{message}</p>}
    {report && <><p>観測日時：{report.observedAt} ／ 記録日時：{report.recordedAt} ／ 記録者：{report.author}</p>
      <p>{report.scope}</p><p>記録時点の調査です。現在の状態や安全性を保証するものではありません。</p>
      {sections.map(([key, title]) => <details key={key} open={key === 'vulnerabilities'}>
        <summary>{title} — {labels[report[key].status]}</summary><p>{report[key].summary}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{report[key].details}</pre>
      </details>)}
    </>}
  </section>;
}
