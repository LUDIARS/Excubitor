import { useEffect, useRef, useState } from 'react';
import { subscribeLogs } from '../lib/api';

interface Line {
  channel: string;
  ts: string;
  line: string;
}

const MAX_LINES = 500;
const RECENT_LIMIT = 100;

export default function LogsDrawer({ code, onClose }: { code: string; onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<'loading' | 'live' | 'error'>('loading');
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let unsub = () => {};

    // 1) recent を fetch して初期表示
    (async () => {
      try {
        const res = await fetch(`/api/v1/services/${encodeURIComponent(code)}/logs/recent?limit=${RECENT_LIMIT}`);
        const data = (await res.json()) as { lines: Array<{ ts: string; level: string | null; line: string }> };
        if (cancelled) return;
        // recent は desc 順なので reverse して時系列に
        const initial = [...data.lines].reverse().map((l) => ({
          channel: l.level === 'error' || l.level === 'fatal' ? 'stderr' : 'stdout',
          ts: l.ts,
          line: l.line,
        }));
        setLines(initial);
      } catch (err) {
        if (!cancelled) setStatus('error');
        console.error('recent logs failed', err);
      }

      // 2) SSE で live tail
      if (!cancelled) {
        unsub = subscribeLogs(code, (l) => {
          setLines((prev) => {
            const next = [...prev, l];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        });
        setStatus('live');
      }
    })();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [code]);

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [lines]);

  return (
    <aside className="logs-drawer">
      <header>
        <strong>{code}</strong>
        <span className={`muted status-${status}`}>{status === 'live' ? '● live' : status}</span>
        <button onClick={onClose} className="close">×</button>
      </header>
      <div
        className="logs-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        }}
      >
        {lines.length === 0 && status === 'loading' && (
          <div className="logs-empty">読み込み中…</div>
        )}
        {lines.length === 0 && status !== 'loading' && (
          <div className="logs-empty">ログなし (新しい line を待機中)</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`log-line ${l.channel}`}>
            <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
            <span className="line">{l.line}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
