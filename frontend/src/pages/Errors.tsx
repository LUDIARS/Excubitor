import { useEffect, useState } from 'react';
import type { ErrorTask, AutoFixRun } from '../lib/api';
import { fetchErrorTasks, triageErrorTask, triggerAutoFix, triggerInvestigate, fetchAutoFixRuns } from '../lib/api';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _AutoFixRun = null as unknown as AutoFixRun;

export default function Errors() {
  const [tasks, setTasks] = useState<ErrorTask[] | null>(null);
  const [filter, setFilter] = useState<string>('open');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AutoFixRun[]>>({});
  const [busy, setBusy] = useState<Record<string, 'fix' | 'investigate' | null>>({});

  const reload = async () => {
    try {
      const list = await fetchErrorTasks(filter || undefined);
      setTasks(list);
    } catch (err) {
      console.error(err);
    }
  };

  const refreshRuns = async (id: string) => {
    try {
      const list = await fetchAutoFixRuns(id);
      setRuns((r) => ({ ...r, [id]: list }));
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

  // 展開中のタスクの runs を 5 秒おきに自動更新 (実行中の調査/修正の終了を捉える)
  useEffect(() => {
    if (!expanded) return;
    const id = setInterval(() => void refreshRuns(expanded), 5000);
    return () => clearInterval(id);
  }, [expanded]);

  const act = async (id: string, state: string) => {
    await triageErrorTask(id, { state });
    void reload();
  };

  const onInvestigate = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: 'investigate' }));
    try {
      const res = await triggerInvestigate(id);
      if (res.error) alert(`調査 失敗: ${res.message ?? res.error}`);
      // 結果がタスク行で読めるよう自動展開
      setExpanded(id);
      await refreshRuns(id);
      void reload();
    } finally {
      setBusy((b) => ({ ...b, [id]: null }));
    }
  };

  const onAutoFix = async (id: string) => {
    if (!window.confirm('Claude Code CLI で自動修正を試みます (branch 作成 + commit + push + PR)。 実行しますか?')) return;
    setBusy((b) => ({ ...b, [id]: 'fix' }));
    try {
      const res = await triggerAutoFix(id);
      if (res.error) alert(`修正 失敗: ${res.message ?? res.error}`);
      setExpanded(id);
      await refreshRuns(id);
      void reload();
    } finally {
      setBusy((b) => ({ ...b, [id]: null }));
    }
  };

  const toggleExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!runs[id]) await refreshRuns(id);
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
                    <AutoFixCell
                      t={t}
                      onInvestigate={() => void onInvestigate(t.id)}
                      onFix={() => void onAutoFix(t.id)}
                      onExpand={() => void toggleExpand(t.id)}
                      expanded={expanded === t.id}
                      busy={busy[t.id] ?? null}
                      runs={runs[t.id] ?? null}
                    />
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
  onInvestigate,
  onFix,
  onExpand,
  expanded,
  busy,
  runs,
}: {
  t: ErrorTask;
  onInvestigate: () => void;
  onFix: () => void;
  onExpand: () => void;
  expanded: boolean;
  busy: 'fix' | 'investigate' | null;
  runs: AutoFixRun[] | null;
}) {
  // 直近の run があれば action_type 別に集計して「最後の調査 / 最後の修正」 を表示。
  // 無ければ auto_fix_state (旧 v0.1 互換) のラベルを fallback で出す。
  const lastInvestigate = runs?.find((r) => r.action_type === 'investigate') ?? null;
  const lastFix = runs?.find((r) => r.action_type === 'fix') ?? null;
  return (
    <div className="af-cell">
      <div className="af-buttons">
        <button
          onClick={onInvestigate}
          className="af-investigate"
          title="claude に原因解析を依頼 (ファイル / git は触らない)"
          disabled={busy !== null}
        >
          {busy === 'investigate' ? '⟳ 調査中…' : '🔍 調査'}
        </button>
        <button
          onClick={onFix}
          className="af-fix"
          title="claude に修正を依頼 (branch + commit + push + PR)"
          disabled={busy !== null}
        >
          {busy === 'fix' ? '⟳ 修正中…' : '🔧 修正'}
        </button>
        <button onClick={onExpand} className="af-expand" title="run 履歴と結果">
          {expanded ? '−' : '+'}
        </button>
      </div>
      <div className="af-summary">
        {lastInvestigate && <AfBadge run={lastInvestigate} label="調査" />}
        {lastFix && <AfBadge run={lastFix} label="修正" />}
        {!lastInvestigate && !lastFix && t.auto_fix_attempts > 0 && (
          <span className="af-state af-idle muted">{t.auto_fix_attempts}回試行 (v0.1)</span>
        )}
      </div>
    </div>
  );
}

function AfBadge({ run, label }: { run: AutoFixRun; label: string }) {
  const icon =
    run.state === 'succeeded' ? '✓'
    : run.state === 'failed' ? '✗'
    : run.state === 'running' ? '⟳'
    : run.state === 'verifying' ? '⟳'
    : run.state === 'awaiting_human' ? '⚠'
    : '·';
  return <span className={`af-state af-${run.state}`} title={`最後の${label}: ${run.state}`}>{icon} {label}</span>;
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
  const isInvestigate = r.action_type === 'investigate';
  const dur = r.started_at && r.finished_at
    ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
    : null;
  return (
    <div className={`af-run af-${r.state} af-action-${r.action_type}`}>
      <div className="af-run-head">
        <span className={`af-action-badge af-action-${r.action_type}`}>
          {isInvestigate ? '🔍 調査' : '🔧 修正'}
        </span>
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
      {!isInvestigate && (
        <div className="muted af-meta">
          {r.branch && <>branch: <code>{r.branch}</code> </>}
          {r.commit_hash && <>commit: <code>{r.commit_hash.slice(0, 8)}</code> </>}
          {r.verify_result && <>verify: <span className={`verify-${r.verify_result}`}>{r.verify_result}</span></>}
        </div>
      )}
      {/* 調査結果: stdout (= 解析テキスト本体) を最初から見せる。
          修正 (fix) は内部ログなので折りたたみで OK。 */}
      {isInvestigate && r.stdout_tail && (
        <details className="af-investigate-result" open>
          <summary>解析結果</summary>
          <pre className="af-stdout">{r.stdout_tail}</pre>
        </details>
      )}
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
          {/* fix のときは stdout もここに */}
          {!isInvestigate && r.stdout_tail && (
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
