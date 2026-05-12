import { useEffect, useState } from 'react';
import type { ErrorTask, AutoFixRun } from '../lib/api';
import { fetchErrorTasks, triageErrorTask, triggerAutoFix, fetchAutoFixRuns } from '../lib/api';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _AutoFixRun = null as unknown as AutoFixRun;

export default function Errors() {
  const [tasks, setTasks] = useState<ErrorTask[] | null>(null);
  const [filter, setFilter] = useState<string>('open');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AutoFixRun[]>>({});

  const reload = async () => {
    try {
      const list = await fetchErrorTasks(filter || undefined);
      setTasks(list);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const act = async (id: string, state: string) => {
    await triageErrorTask(id, { state });
    void reload();
  };

  const onAutoFix = async (id: string) => {
    if (!window.confirm('Claude Code CLI で自動修正を試みます (branch 作成 + commit + push + PR)。 実行しますか?')) return;
    const res = await triggerAutoFix(id);
    if (res.error) alert(`auto-fix 失敗: ${res.message ?? res.error}`);
    void reload();
  };

  const toggleExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!runs[id]) {
      try {
        const list = await fetchAutoFixRuns(id);
        setRuns((r) => ({ ...r, [id]: list }));
      } catch (err) {
        console.error(err);
      }
    }
  };

  return (
    <>
      <div className="toolbar">
        <label>state:</label>
        {['open', 'ack', 'snoozed', 'resolved', 'dismissed', ''].map((s) => (
          <button
            key={s}
            className={filter === s ? 'active' : ''}
            onClick={() => setFilter(s)}
          >
            {s || 'all'}
          </button>
        ))}
      </div>
      {tasks === null && <div className="empty-state">読み込み中…</div>}
      {tasks !== null && tasks.length === 0 && <div className="empty-state">エラータスクなし</div>}
      {tasks !== null && tasks.length > 0 && (
        <table className="error-table">
          <thead>
            <tr>
              <th>sev</th>
              <th>service</th>
              <th>summary</th>
              <th>count</th>
              <th>last seen</th>
              <th>state</th>
              <th>auto-fix</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <>
                <tr key={t.id}>
                  <td><span className={`severity ${t.severity}`}>{t.severity}</span></td>
                  <td>{t.service_code ?? '—'}</td>
                  <td>
                    <div className="task-summary" title={t.log_excerpt ?? ''}>{t.summary}</div>
                  </td>
                  <td>{t.occurrence_count}</td>
                  <td>{new Date(t.last_seen_at).toLocaleString()}</td>
                  <td>{t.state}</td>
                  <td>
                    <AutoFixCell t={t} onTrigger={() => void onAutoFix(t.id)} onExpand={() => void toggleExpand(t.id)} expanded={expanded === t.id} />
                  </td>
                  <td className="task-actions">
                    {t.state !== 'ack' && <button onClick={() => void act(t.id, 'ack')}>ack</button>}
                    {t.state !== 'resolved' && <button onClick={() => void act(t.id, 'resolved')}>resolve</button>}
                    {t.state !== 'dismissed' && <button onClick={() => void act(t.id, 'dismissed')}>dismiss</button>}
                  </td>
                </tr>
                {expanded === t.id && (
                  <tr className="expand-row">
                    <td colSpan={8}>
                      <AutoFixRuns runs={runs[t.id] ?? null} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function AutoFixCell({
  t,
  onTrigger,
  onExpand,
  expanded,
}: {
  t: ErrorTask;
  onTrigger: () => void;
  onExpand: () => void;
  expanded: boolean;
}) {
  const state = t.auto_fix_state;
  const label =
    state === 'succeeded' ? '✓ fixed'
    : state === 'failed' ? '✗ failed'
    : state === 'running' ? '⟳ running'
    : state === 'awaiting_human' ? '⚠ human'
    : state === 'verifying' ? '⟳ verify'
    : state ? state
    : t.auto_fix_attempts > 0 ? `${t.auto_fix_attempts}回試行` : '—';
  const cls = `af-state af-${state ?? 'idle'}`;
  return (
    <div className="af-cell">
      <span className={cls}>{label}</span>
      {(state === null || state === 'awaiting_human' || state === 'failed') && (
        <button onClick={onTrigger} className="af-trigger" title="auto-fix を手動 trigger">
          ⚙
        </button>
      )}
      <button onClick={onExpand} className="af-expand" title="run 履歴">
        {expanded ? '−' : '+'}
      </button>
    </div>
  );
}

function AutoFixRuns({ runs }: { runs: AutoFixRun[] | null }) {
  if (runs === null) return <div className="muted">読み込み中…</div>;
  if (runs.length === 0) return <div className="muted">auto-fix run なし</div>;
  return (
    <div className="af-runs">
      {runs.map((r) => (
        <AutoFixRunCard key={r.id} r={r} />
      ))}
    </div>
  );
}

function AutoFixRunCard({ r }: { r: AutoFixRun }) {
  const [showDetail, setShowDetail] = useState(false);
  const dur = r.started_at && r.finished_at
    ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
    : null;
  return (
    <div className={`af-run af-${r.state}`}>
      <div className="af-run-head">
        <strong>{r.state}</strong>
        <span className="muted">{r.triggered_by}</span>
        <span className="muted">{r.started_at && new Date(r.started_at).toLocaleString()}</span>
        {dur && <span className="muted">{dur}</span>}
        {r.exit_code !== null && r.exit_code !== undefined && <span className="muted">exit={r.exit_code}</span>}
        {r.pr_url && <a href={r.pr_url} target="_blank" rel="noreferrer">PR ↗</a>}
        <button onClick={() => setShowDetail((s) => !s)} className="af-detail-btn">
          {showDetail ? '詳細 −' : '詳細 +'}
        </button>
      </div>
      <div className="muted af-meta">
        {r.branch && <>branch: <code>{r.branch}</code> </>}
        {r.commit_hash && <>commit: <code>{r.commit_hash.slice(0, 8)}</code> </>}
        {r.verify_result && <>verify: <span className={`verify-${r.verify_result}`}>{r.verify_result}</span></>}
      </div>
      {r.error_message && (
        <details className="af-error-details" open={!showDetail}>
          <summary>error_message</summary>
          <pre className="af-error">{r.error_message}</pre>
        </details>
      )}
      {showDetail && (
        <div className="af-detail">
          {r.stderr_tail && (
            <details open>
              <summary>stderr (tail)</summary>
              <pre className="af-stderr">{r.stderr_tail}</pre>
            </details>
          )}
          {r.stdout_tail && (
            <details>
              <summary>stdout (tail)</summary>
              <pre className="af-stdout">{r.stdout_tail}</pre>
            </details>
          )}
          {r.prompt && (
            <details>
              <summary>prompt (sent to Claude)</summary>
              <pre className="af-prompt">{r.prompt}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
