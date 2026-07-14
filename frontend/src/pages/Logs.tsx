import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllRecentLogs,
  fetchProjects,
  fetchVgLogs,
  subscribeAllLogs,
  type RecentLogLine,
  type VgLogLine,
} from '../lib/api';

type Mode = 'live' | 'vg';

interface ServiceOption {
  code: string;
  name: string;
}

export default function Logs() {
  const [mode, setMode] = useState<Mode>('live');
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [liveLines, setLiveLines] = useState<Array<{ code: string; ts: string; channel: string; line: string }>>([]);
  const [recentLines, setRecentLines] = useState<RecentLogLine[]>([]);
  const [vgLines, setVgLines] = useState<VgLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const codes = useMemo(() => Array.from(selected), [selected]);

  useEffect(() => {
    void fetchProjects()
      .then((projects) => {
        const list = projects.flatMap((p) => p.components.map((c) => ({ code: c.code, name: c.name })));
        setServices(list.sort((a, b) => a.code.localeCompare(b.code)));
      })
      .catch((e: unknown) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        if (mode === 'vg') {
          const logs = await fetchVgLogs(codes, 800);
          if (!stopped) setVgLines(logs);
        } else {
          const logs = await fetchAllRecentLogs(codes, 800);
          if (!stopped) setRecentLines(logs);
        }
        if (!stopped) setError(null);
      } catch (e: unknown) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void load();
    const id = setInterval(() => void load(), mode === 'vg' ? 10_000 : 30_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [mode, codes.join(',')]);

  useEffect(() => {
    if (mode !== 'live') return undefined;
    return subscribeAllLogs((line) => {
      setLiveLines((prev) => [...prev.slice(-500), line]);
    }, codes);
  }, [mode, codes.join(',')]);

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const rows = mode === 'vg'
    ? vgLines.map((l, i) => ({
        key: `vg-${i}-${l.ts}`,
        code: l.service_code,
        ts: new Date(l.ts).toISOString(),
        channel: l.channel,
        line: String(l.line ?? l.message ?? l.text ?? JSON.stringify(l)),
      }))
    : [
        ...liveLines.map((l, i) => ({ key: `live-${i}-${l.ts}`, ...l })),
        ...recentLines.map((l) => ({
          key: `recent-${l.id}`,
          code: l.code ?? '-',
          ts: typeof l.ts === 'number' ? new Date(l.ts).toISOString() : String(l.ts),
          channel: l.level ?? 'log',
          line: l.line,
        })),
      ].slice(-900).reverse();

  return (
    <div className="logs-page">
      {error && <div className="error-banner">Error: {error}</div>}
      <div className="logs-toolbar">
        <div className="segmented">
          <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>Live</button>
          <button className={mode === 'vg' ? 'active' : ''} onClick={() => setMode('vg')}>Vg</button>
        </div>
        <button onClick={() => setSelected(new Set())}>All services</button>
        <span className="muted">{selected.size === 0 ? 'showing all' : `${selected.size} filtered`}</span>
      </div>

      <div className="logs-layout">
        <aside className="logs-service-filter">
          {services.map((svc) => (
            <label key={svc.code}>
              <input type="checkbox" checked={selected.has(svc.code)} onChange={() => toggle(svc.code)} />
              <span>{svc.code}</span>
            </label>
          ))}
        </aside>
        <section className="logs-console">
          {rows.length === 0 && <div className="logs-empty">No logs.</div>}
          {rows.map((row) => (
            <div className="logs-console-row" key={row.key}>
              <span className="ts">{row.ts}</span>
              <span className="code">{row.code}</span>
              <span className="channel">{row.channel}</span>
              <span className="line">{row.line}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
