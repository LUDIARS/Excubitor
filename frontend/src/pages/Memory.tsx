import { useEffect, useState } from 'react';
import { fetchMemorySummary, type MemoryCard, type MemorySummary, type LeakVerdict } from '../lib/api';
import Sparkline from '../components/Sparkline';

export default function Memory() {
  const [data, setData] = useState<MemorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const d = await fetchMemorySummary();
        if (!stopped) {
          setData(d);
          setError(null);
        }
      } catch (e: unknown) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="memory">
      {error && <div className="error-banner">エラー: {error}</div>}
      {data === null && !error && <div className="empty-state">読み込み中…</div>}
      {data && (
        <>
          <h2 className="mem-section-title">サービス</h2>
          {data.services.length === 0 ? (
            <div className="empty-state">running なサービスのメモリサンプルがまだありません。</div>
          ) : (
            <div className="mem-grid">
              {data.services.map((c) => (
                <MemCard key={`${c.target_kind}:${c.target_key}`} c={c} />
              ))}
            </div>
          )}

          <h2 className="mem-section-title">WSL バックエンド</h2>
          {data.wsl.length === 0 ? (
            <div className="empty-state">WSL サンプルなし (WSL 未起動 / 無効)。</div>
          ) : (
            <div className="mem-grid">
              {data.wsl.map((c) => (
                <MemCard key={`${c.target_kind}:${c.target_key}`} c={c} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const VERDICT_LABEL: Record<LeakVerdict, string> = {
  insufficient: 'データ不足',
  ok: '正常',
  suspect: '疑い',
  leaking: 'リーク',
};

function MemCard({ c }: { c: MemoryCard }) {
  const slopeMb = c.leak.slopeBytesPerHour / (1024 * 1024);
  const verdictColor = c.leak.verdict === 'leaking' ? '#f87171' : c.leak.verdict === 'suspect' ? '#fbbf24' : '#60a5fa';
  return (
    <article className={`mem-card ${c.leak.verdict}`}>
      <div className="mem-card-head">
        <span className="mem-name">{c.name}</span>
        <span className={`mem-badge ${c.leak.verdict}`}>{VERDICT_LABEL[c.leak.verdict]}</span>
      </div>
      <div className="mem-rss">{formatBytes(c.rss_bytes)}</div>
      <Sparkline points={c.spark} color={verdictColor} />
      <div className="mem-meta">
        <span>傾き: {slopeMb >= 0 ? '+' : ''}{slopeMb.toFixed(1)} MB/h</span>
        {c.leak.verdict !== 'insufficient' && (
          <span> · 単調 {(c.leak.monotonicRatio * 100).toFixed(0)}%</span>
        )}
        <span> · {c.primary_source}</span>
        {c.pid != null && <span> · pid {c.pid}</span>}
      </div>
      {c.heap_used_bytes != null && (
        <div className="mem-heap">
          heap {formatBytes(c.heap_used_bytes)} / {formatBytes(c.heap_total_bytes)}
          {c.external_bytes != null && <> · external {formatBytes(c.external_bytes)}</>}
        </div>
      )}
    </article>
  );
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / 1024 ** 2;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
