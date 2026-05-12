import { useEffect, useState } from 'react';

interface ReviewSummary {
  repo: string;
  latest_date: string | null;
  weighted_score: string | null;
  critical_count: number;
  high_count: number;
  fix_pr: string | null;
}

interface RepoDetail {
  repo: string;
  dates: string[];
  latest: {
    date: string;
    weighted_score?: string;
    scores?: Record<string, string>;
    critical_count?: number;
    high_count?: number;
    fix_pr?: string | null;
  } | null;
}

const REVIEW_FILES: Array<{ id: string; label: string }> = [
  { id: 'REVIEW.md', label: '総合' },
  { id: 'REVIEW_DESIGN.md', label: '設計' },
  { id: 'REVIEW_VULNERABILITY.md', label: '脆弱性' },
  { id: 'REVIEW_IMPLEMENTATION.md', label: '実装' },
  { id: 'REVIEW_MISSING_FEATURES.md', label: '不足機能' },
  { id: 'REVIEW_QUALITY.md', label: '品質' },
];

export default function Reviews() {
  const [items, setItems] = useState<ReviewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RepoDetail | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [file, setFile] = useState<string>('REVIEW.md');
  const [body, setBody] = useState<string>('');

  const reload = async () => {
    try {
      const res = await fetch('/api/v1/reviews');
      if (!res.ok) throw new Error(`${res.status}`);
      const d = (await res.json()) as { items: ReviewSummary[] };
      setItems(d.items);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    void (async () => {
      try {
        const res = await fetch(`/api/v1/reviews/${encodeURIComponent(selected)}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const d = (await res.json()) as RepoDetail;
        setDetail(d);
        setDate(d.dates[0] ?? null);
      } catch (e: unknown) {
        setError((e as Error).message);
      }
    })();
  }, [selected]);

  useEffect(() => {
    if (!selected || !date) { setBody(''); return; }
    void (async () => {
      try {
        const res = await fetch(`/api/v1/reviews/${encodeURIComponent(selected)}/${date}/${file}`);
        setBody(res.ok ? await res.text() : `${res.status}: ${await res.text()}`);
      } catch (e: unknown) {
        setBody(`読み込みエラー: ${(e as Error).message}`);
      }
    })();
  }, [selected, date, file]);

  return (
    <>
      {error && <div className="error-banner">エラー: {error}</div>}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <aside style={{ width: 280, flexShrink: 0 }}>
          <h3 style={{ margin: '0 0 8px' }}>LUDIARS リポジトリ</h3>
          {items === null && <div className="empty-state">読み込み中…</div>}
          {items !== null && items.length === 0 && (
            <div className="empty-state">レビューが見つかりません。 /ludiars-review を実行してください。</div>
          )}
          {items !== null && items.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {items.map((it) => (
                <li key={it.repo}>
                  <button
                    type="button"
                    onClick={() => setSelected(it.repo)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '6px 8px', marginBottom: 4,
                      background: selected === it.repo ? 'var(--accent-bg, #eef)' : 'transparent',
                      border: '1px solid var(--border, #ddd)', borderRadius: 4, cursor: 'pointer',
                    }}
                  >
                    <strong>{it.repo}</strong>
                    {' '}
                    {it.weighted_score && <span className="badge">{it.weighted_score}</span>}
                    {' '}
                    {it.latest_date && <small style={{ color: '#888' }}>{it.latest_date}</small>}
                    {(it.critical_count > 0 || it.high_count > 0) && (
                      <small style={{ color: '#d97706' }}> ⚠ C{it.critical_count}/H{it.high_count}</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => void reload()} style={{ marginTop: 8 }}>更新</button>
        </aside>
        <section style={{ flex: 1, minWidth: 0 }}>
          {!selected && <div className="empty-state">左のリポジトリを選択してください</div>}
          {selected && detail && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <strong>{selected}</strong>
                <label>
                  日付{' '}
                  <select value={date ?? ''} onChange={(e) => setDate(e.target.value)}>
                    {detail.dates.map((d) => (<option key={d} value={d}>{d}</option>))}
                  </select>
                </label>
                {detail.latest?.fix_pr && (
                  <a href={detail.latest.fix_pr} target="_blank" rel="noopener noreferrer">自動修正 PR</a>
                )}
              </div>
              <nav className="tabs" style={{ marginBottom: 8 }}>
                {REVIEW_FILES.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={file === f.id ? 'active' : ''}
                    onClick={() => setFile(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </nav>
              <pre style={{
                whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5,
                padding: 12, border: '1px solid var(--border, #ddd)', borderRadius: 4,
                background: 'var(--code-bg, #fafafa)',
              }}>{body}</pre>
            </>
          )}
        </section>
      </div>
    </>
  );
}
