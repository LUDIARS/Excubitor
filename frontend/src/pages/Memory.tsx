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
      {error && <div className="error-banner">Error: {error}</div>}
      {data === null && !error && <div className="empty-state">Loading...</div>}
      {data && (
        <>
          {data.host && (
            <>
              <h2 className="mem-section-title">Host</h2>
              <div className="mem-grid">
                <HostCard c={data.host} />
              </div>
            </>
          )}

          <h2 className="mem-section-title">Services</h2>
          {data.services.length === 0 ? (
            <div className="empty-state">No running service samples yet.</div>
          ) : (
            <div className="mem-grid">
              {data.services.map((c) => (
                <MemCard key={`${c.target_kind}:${c.target_key}`} c={c} />
              ))}
            </div>
          )}

          <h2 className="mem-section-title">WSL</h2>
          {data.wsl.length === 0 ? (
            <div className="empty-state">No WSL samples.</div>
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
  insufficient: 'no data',
  ok: 'ok',
  suspect: 'suspect',
  leaking: 'leaking',
};

function MemCard({ c }: { c: MemoryCard }) {
  const slopeMb = c.leak.slopeBytesPerHour / (1024 * 1024);
  const verdictColor = c.budget.ok === false
    ? '#f87171'
    : c.leak.verdict === 'leaking'
      ? '#f87171'
      : c.leak.verdict === 'suspect'
        ? '#fbbf24'
        : '#60a5fa';
  return (
    <article className={`mem-card ${c.leak.verdict} ${c.budget.ok === false ? 'over-budget' : ''}`}>
      <div className="mem-card-head">
        <span className="mem-name">{c.name}</span>
        <span className={`mem-badge ${c.budget.ok === false ? 'over-budget' : c.leak.verdict}`}>
          {c.budget.ok === false ? 'over budget' : VERDICT_LABEL[c.leak.verdict]}
        </span>
      </div>
      <div className="mem-rss">
        {formatBytes(c.rss_bytes)}
        {c.cpu_pct != null && <span className="mem-cpu"> CPU {c.cpu_pct.toFixed(1)}%</span>}
      </div>
      <Sparkline points={c.spark} color={verdictColor} />
      <BudgetLine c={c} />
      <div className="mem-meta">
        <span>slope {slopeMb >= 0 ? '+' : ''}{slopeMb.toFixed(1)} MB/h</span>
        {c.leak.verdict !== 'insufficient' && (
          <span> monotonic {(c.leak.monotonicRatio * 100).toFixed(0)}%</span>
        )}
        <span> {c.primary_source}</span>
        {c.pid != null && <span> pid {c.pid}</span>}
      </div>
      {c.heap_used_bytes != null && (
        <div className="mem-heap">
          heap {formatBytes(c.heap_used_bytes)} / {formatBytes(c.heap_total_bytes)}
          {c.external_bytes != null && <> external {formatBytes(c.external_bytes)}</>}
        </div>
      )}
    </article>
  );
}

function HostCard({ c }: { c: MemoryCard }) {
  const total = typeof c.detail?.totalMemBytes === 'number' ? c.detail.totalMemBytes : null;
  const memPct = total && c.rss_bytes != null ? (c.rss_bytes / total) * 100 : null;
  return (
    <article className="mem-card host">
      <div className="mem-card-head">
        <span className="mem-name">{c.name}</span>
        {c.cpu_pct != null && <span className="mem-badge ok">CPU {c.cpu_pct.toFixed(1)}%</span>}
      </div>
      <div className="mem-rss">
        Memory {formatBytes(c.rss_bytes)}
        {total != null && <> / {formatBytes(total)}</>}
        {memPct != null && <span className="mem-cpu"> ({memPct.toFixed(0)}%)</span>}
      </div>
      <Sparkline points={c.cpu_spark.map((p) => ({ t: p.t, rss: p.cpu }))} color="#34d399" />
      <div className="mem-meta">
        <span>CPU usage trend</span>
        {typeof c.detail?.cpuCount === 'number' && <span> {c.detail.cpuCount} cores</span>}
      </div>
    </article>
  );
}

function BudgetLine({ c }: { c: MemoryCard }) {
  const hasBudget = c.budget.rss_budget_bytes != null || c.budget.cpu_budget_pct != null;
  if (!hasBudget) return <div className="mem-budget muted">No budget set</div>;
  return (
    <div className={`mem-budget ${c.budget.ok === false ? 'bad' : 'ok'}`}>
      {c.budget.rss_budget_bytes != null && (
        <span>Memory {c.budget.rss_ok === false ? 'over' : 'ok'} / {formatBytes(c.budget.rss_budget_bytes)}</span>
      )}
      {c.budget.cpu_budget_pct != null && (
        <span>CPU {c.budget.cpu_ok === false ? 'over' : 'ok'} / {c.budget.cpu_budget_pct}%</span>
      )}
    </div>
  );
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / 1024 ** 2;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
