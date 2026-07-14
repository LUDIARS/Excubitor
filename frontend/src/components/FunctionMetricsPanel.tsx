import { useEffect, useState } from 'react';
import type {
  Component,
  FunctionMetricAggregate,
  FunctionMetricSort,
  ServiceFunctionMetrics,
} from '../lib/api';
import { fetchFunctionMetrics } from '../lib/api';

export default function FunctionMetricsPanel({
  candidates,
  selectedCode,
  onSelectCode,
}: {
  candidates: Component[];
  selectedCode: string;
  onSelectCode: (code: string) => void;
}) {
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState<FunctionMetricSort>('totalMs');
  const [data, setData] = useState<ServiceFunctionMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!selectedCode) return;
    setBusy(true);
    try {
      const result = await fetchFunctionMetrics(selectedCode, {
        limit: 30,
        kind: kind || undefined,
        sort,
      });
      setData(result);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedCode) return;
    let stopped = false;
    let pending = false;
    const tick = async () => {
      if (pending) return;
      pending = true;
      setBusy(true);
      try {
        const result = await fetchFunctionMetrics(selectedCode, {
          limit: 30,
          kind: kind || undefined,
          sort,
        });
        if (!stopped) {
          setData(result);
          setError(null);
        }
      } catch (e: unknown) {
        if (!stopped) setError((e as Error).message);
      } finally {
        pending = false;
        if (!stopped) setBusy(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [selectedCode, kind, sort]);

  const totals = data?.snapshot.totals ?? null;
  const metricRows = data?.snapshot.rows ?? [];
  const generatedAt = data?.snapshot.generatedAt ? new Date(data.snapshot.generatedAt).toLocaleTimeString() : '-';

  return (
    <section className="function-metrics-panel">
      <div className="function-metrics-head">
        <div>
          <h2>Function Metrics</h2>
          <div className="function-metrics-sub">
            {data?.source_url ?? 'Lapilli AOP runtime snapshot'}
          </div>
        </div>
        <div className="function-metrics-controls">
          <label>
            Service
            <select value={selectedCode} onChange={(e) => onSelectCode(e.target.value)}>
              {candidates.map((c) => (
                <option key={c.code} value={c.code}>{c.code}</option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">all</option>
              <option value="api">api</option>
              <option value="discord">discord</option>
              <option value="function">function</option>
              <option value="method">method</option>
            </select>
          </label>
          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as FunctionMetricSort)}>
              <option value="totalMs">total time</option>
              <option value="calls">calls</option>
              <option value="avgMs">avg time</option>
              <option value="maxMs">max time</option>
              <option value="lastAt">latest</option>
            </select>
          </label>
          <button disabled={busy || !selectedCode} onClick={() => void load()}>
            {busy ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="function-metrics-summary">
        <span className="metric-pill">calls <strong>{totals?.calls ?? '-'}</strong></span>
        <span className="metric-pill">ok <strong>{totals?.ok ?? '-'}</strong></span>
        <span className={`metric-pill ${totals && totals.errors > 0 ? 'bad' : ''}`}>errors <strong>{totals?.errors ?? '-'}</strong></span>
        <span className="metric-pill">avg <strong>{fmtMetricMs(totals?.avgMs)}</strong></span>
        <span className="metric-pill">total <strong>{fmtMetricMs(totals?.totalMs)}</strong></span>
        <span className="metric-pill">updated <strong>{generatedAt}</strong></span>
      </div>

      {error && <div className="metric-error">{error}</div>}
      {!error && metricRows.length === 0 && <div className="metric-empty">No function metrics reported.</div>}
      {metricRows.length > 0 && (
        <div className="function-metrics-table-wrap">
          <table className="function-metrics-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Target</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>Avg</th>
                <th>Max</th>
                <th>Total</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              {metricRows.map((row) => (
                <FunctionMetricRow key={row.key} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FunctionMetricRow({ row }: { row: FunctionMetricAggregate }) {
  const errorTitle = Object.entries(row.errorNames ?? {})
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');
  return (
    <tr>
      <td><span className="metric-kind">{row.kind}</span></td>
      <td>
        <div className="metric-target">{row.target}</div>
        <div className="metric-domain">{row.domain}{row.tags?.method ? ` / ${row.tags.method}` : ''}</div>
      </td>
      <td>{row.calls}</td>
      <td className={row.errors > 0 ? 'metric-bad' : ''} title={errorTitle || undefined}>{row.errors}</td>
      <td>{fmtMetricMs(row.avgMs)}</td>
      <td>{fmtMetricMs(row.maxMs)}</td>
      <td>{fmtMetricMs(row.totalMs)}</td>
      <td>
        <div className={`metric-status ${row.lastStatus ?? 'unknown'}`}>{row.lastStatus ?? '-'}</div>
        <div className="metric-time">{fmtMetricTime(row.lastAt)}</div>
      </td>
    </tr>
  );
}

function fmtMetricMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  if (value < 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(0)}ms`;
}

function fmtMetricTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '-';
  return new Date(value).toLocaleTimeString();
}
