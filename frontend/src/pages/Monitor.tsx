import { useEffect, useMemo, useState } from 'react';
import type {
  Project, Component, ControlAction, PortReport, ServicePortStatus,
  LaunchPlan, MemoryCard, BranchStatus, UpdateStatus, DiscoveryResult, LivenessSeries,
} from '../lib/api';
import {
  fetchProjects, controlService, fetchPorts, setCorpusPref, fetchBranchStatus, applyUpdate,
  fetchLaunchPlan, saveLaunchProfile, launchStart, launchStop,
  fetchMemorySummary, fetchUpdates, fetchDiscovery, scanCatalog, fetchLiveness,
} from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';
import MetricGraph from '../components/MetricGraph';

/**
 * 統合 Monitor。 旧 Launch / Launcher / Monitor を 1 画面に集約する:
 *  - サービスを横 1 列の行で表示。 起動/停止/再起動/ログ/更新(pull)/ブランチ + 次回起動チェック。
 *  - 起動中の行のみメトリクスグラフ (稼働率 / CPU / メモリ) を出す。
 *  - 上部バーで起動セット保存・全起動/全停止・更新確認・スキャン。
 *  - スキャンは未登録 repo を解析して catalog を自動生成する。
 */
export default function Monitor() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [ports, setPorts] = useState<PortReport | null>(null);
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [memByCode, setMemByCode] = useState<Map<string, MemoryCard>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [logsOpenFor, setLogsOpenFor] = useState<string | null>(null);

  // 起動セット選択 (profile.selection のローカル編集)。
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 更新確認 / 検出。
  const [updates, setUpdates] = useState<Map<string, UpdateStatus>>(new Map());
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);

  const reloadCore = async () => {
    try {
      const [list, portReport, mem] = await Promise.all([
        fetchProjects(),
        fetchPorts().catch(() => null),
        fetchMemorySummary().catch(() => null),
      ]);
      setProjects(list);
      setPorts(portReport);
      if (mem) setMemByCode(new Map(mem.services.map((s) => [s.target_key, s])));
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const reloadPlan = async () => {
    const p = await fetchLaunchPlan();
    setPlan(p);
    setAutoLaunch(p.profile.auto_launch);
    setSelection(new Set(p.profile.selection));
  };

  useEffect(() => {
    void reloadCore();
    void reloadPlan().catch(() => {});
    void fetchDiscovery().then(setDiscovery).catch(() => {});
    const id = setInterval(() => void reloadCore(), 5000);
    return () => clearInterval(id);
  }, []);

  const startableSet = useMemo(
    () => new Set((plan?.projects ?? []).flatMap((p) => p.services).filter((s) => s.startable).map((s) => s.code)),
    [plan],
  );
  const portByCode = useMemo(
    () => new Map<string, ServicePortStatus>((ports?.services ?? []).map((s) => [s.code, s])),
    [ports],
  );

  const toggleSelect = (code: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const codes = useMemo(() => Array.from(selection), [selection]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e: unknown) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doSave = () => run('save', async () => {
    await saveLaunchProfile(codes, autoLaunch);
    await reloadPlan();
    setMsg(`起動セットを保存しました (${codes.length} 件、 次回自動=${autoLaunch ? 'ON' : 'OFF'})`);
  });
  const doStartSet = () => run('start', async () => {
    await saveLaunchProfile(codes, autoLaunch);
    const r = await launchStart(codes);
    const ok = r.results.filter((x) => x.ok).length;
    setMsg(`起動: ${ok}/${r.results.length} 成功`);
    await reloadCore();
  });
  const doStopSet = () => run('stop', async () => {
    await launchStop(codes);
    setMsg('起動セットを停止しました');
    await reloadCore();
  });
  const doCheckUpdates = () => run('updates', async () => {
    const list = await fetchUpdates(true);
    setUpdates(new Map(list.map((u) => [u.code, u])));
    const avail = list.filter((u) => u.available).length;
    setMsg(`更新確認: ${avail} 件にアップデートあり`);
  });
  const doScan = () => run('scan', async () => {
    const r = await scanCatalog();
    setMsg(`スキャン完了: ${r.created.length} 件を自動登録 / ポート ${Object.keys(r.ports).length} 件検出 / ${r.skipped.length} 件 skip (catalog ${r.catalog_total} 件)`);
    await Promise.all([reloadCore(), reloadPlan().catch(() => {}), fetchDiscovery().then(setDiscovery).catch(() => {})]);
  });

  const allRows = useMemo(
    () => (projects ?? []).flatMap((p) => p.components.map((c) => ({ project: p.project_code, c }))),
    [projects],
  );

  return (
    <div className="monitor">
      {error && <div className="error-banner">エラー: {error}</div>}
      {msg && <div className="launcher-msg">{msg}</div>}
      {ports?.hasConflict && (
        <div className="error-banner">
          ⚠ ポート衝突: {ports.services.filter((s) => s.conflict).map((s) => `${s.code}(:${s.port})`).join(', ')}
        </div>
      )}

      <div className="monitor-bar">
        <div className="monitor-bar-info">
          <strong>{selection.size}</strong> 件を起動セットに選択中
          <label className="auto-launch">
            <input type="checkbox" checked={autoLaunch} onChange={(e) => setAutoLaunch(e.target.checked)} /> 次回自動起動
          </label>
        </div>
        <div className="monitor-bar-actions">
          <button disabled={busy !== null} onClick={doSave}>{busy === 'save' ? '保存中…' : '起動セット保存'}</button>
          <button className="primary" disabled={busy !== null || selection.size === 0} onClick={doStartSet}>
            {busy === 'start' ? '起動中…' : `セット起動 (${selection.size})`}
          </button>
          <button disabled={busy !== null} onClick={doStopSet}>{busy === 'stop' ? '停止中…' : 'セット停止'}</button>
          <span className="bar-sep" />
          <button disabled={busy !== null} onClick={doCheckUpdates}>{busy === 'updates' ? '確認中…' : '更新確認'}</button>
          <button disabled={busy !== null} onClick={doScan} title="未登録 repo を解析してカタログ自動生成">
            {busy === 'scan' ? 'スキャン中…' : 'スキャン'}
          </button>
        </div>
      </div>

      {discovery && discovery.candidates.length > 0 && (
        <div className="discovery-strip">
          未登録 {discovery.candidates.length} 件: {discovery.candidates.slice(0, 8).map((d) => d.name).join(', ')}
          {discovery.candidates.length > 8 ? ' …' : ''} — 「スキャン」で実行可能なものを自動登録します。
        </div>
      )}

      {projects === null && <div className="empty-state">読み込み中…</div>}
      {projects !== null && allRows.length === 0 && (
        <div className="empty-state">登録サービスがありません。 「スキャン」で検出するか catalog/services.yaml を確認してください。</div>
      )}

      <div className="svc-rows">
        {allRows.map(({ project, c }) => (
          <ServiceRow
            key={c.code}
            project={project}
            c={c}
            port={portByCode.get(c.code)}
            mem={memByCode.get(c.code)}
            update={updates.get(c.code)}
            selectable={startableSet.has(c.code)}
            selected={selection.has(c.code)}
            onToggleSelect={() => toggleSelect(c.code)}
            onShowLogs={() => setLogsOpenFor(c.code)}
            onChanged={reloadCore}
          />
        ))}
      </div>

      {logsOpenFor && <LogsDrawer code={logsOpenFor} onClose={() => setLogsOpenFor(null)} />}
    </div>
  );
}

function ServiceRow({
  project, c, port, mem, update, selectable, selected, onToggleSelect, onShowLogs, onChanged,
}: {
  project: string;
  c: Component;
  port: ServicePortStatus | undefined;
  mem: MemoryCard | undefined;
  update: UpdateStatus | undefined;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onShowLogs: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState<BranchStatus | null>(null);
  const [showBranch, setShowBranch] = useState(false);
  const [live, setLive] = useState<LivenessSeries | null>(null);
  const [usesCorpus, setUsesCorpus] = useState<boolean>(c.uses_corpus ?? false);

  const running = c.state === 'running';
  const isProcess = c.runtime === 'node' || c.runtime === 'dev-process-md' || c.runtime === 'app';
  const isDocker = c.runtime === 'docker-compose' || c.runtime === 'docker';
  const hasRepo = c.git.branch != null;

  useEffect(() => setUsesCorpus(c.uses_corpus ?? false), [c.uses_corpus]);

  // 稼働中のみ稼働率を取得 (CPU/メモリは memory summary 由来)。
  useEffect(() => {
    if (!running) { setLive(null); return; }
    let stop = false;
    const tick = () => void fetchLiveness(c.code, 120).then((l) => { if (!stop) setLive(l); }).catch(() => {});
    tick();
    const id = setInterval(tick, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [running, c.code]);

  const act = async (action: ControlAction) => {
    if (!window.confirm(`${c.code} に対して ${action} を実行しますか?`)) return;
    setBusy(true);
    try {
      const r = await controlService(c.code, action);
      if (!r.ok) alert(`${action} 失敗: ${r.stderr || r.stdout}`);
      await onChanged();
    } finally { setBusy(false); }
  };

  const update_ = async () => {
    if (!window.confirm(`${c.code} を pull (更新) しますか? 起動中なら適用後に再起動します。`)) return;
    setBusy(true);
    try {
      const r = await applyUpdate(c.code, { install: true, restart: running });
      if (!r.ok) {
        const f = r.steps.find((s) => !s.ok);
        alert(`更新失敗 (${c.code}): ${f ? `${f.step}: ${f.detail}` : 'unknown'}`);
      }
      if (showBranch) setBranch(await fetchBranchStatus(c.code).catch(() => null));
      await onChanged();
    } finally { setBusy(false); }
  };

  const toggleBranch = async () => {
    setShowBranch((v) => !v);
    if (branch === null) setBranch(await fetchBranchStatus(c.code).catch(() => null));
  };

  const toggleCorpus = async () => {
    const next = !usesCorpus;
    setUsesCorpus(next);
    try { await setCorpusPref(c.code, next); } catch { setUsesCorpus(!next); }
  };

  const portConflict = port?.conflict;
  const totalMem = mem?.detail?.['totalMemBytes'];
  const memPct = mem?.rss_bytes != null && typeof totalMem === 'number' && totalMem > 0
    ? (mem.rss_bytes / totalMem) * 100
    : null;

  return (
    <div className={`svc-row ${c.state}`}>
      <div className="svc-row-main">
        <span className={`dot ${c.state}`} title={c.state} />
        <label className="svc-row-select" title={selectable ? '次回起動セットに含める' : '起動非対応'}>
          <input type="checkbox" disabled={!selectable} checked={selected} onChange={onToggleSelect} />
        </label>
        <div className="svc-row-id">
          <span className="svc-row-name">{c.component ?? c.name}</span>
          <span className="svc-row-code">{c.code}</span>
        </div>
        <div className="svc-row-tags">
          <span className="tag pcode">{project}</span>
          <span className={`state-badge ${c.state}`}>{c.state}</span>
          {c.runtime && <span className="tag">{c.runtime}</span>}
          {c.tier && <span className="tag tier">{c.tier}</span>}
          <span className={`cc-port ${portConflict ? 'conflict' : ''}`}>{c.port ? `:${c.port}` : '—'}</span>
          {c.git.branch && <code className="svc-row-branch">{c.git.branch}{c.git.dirty ? ' *' : ''}</code>}
          {update?.available && <span className="tag upd" title={`behind ${update.behind}`}>更新あり</span>}
        </div>
        <div className="svc-row-actions">
          {(isProcess || isDocker) && (
            <>
              {!running && <button disabled={busy} onClick={() => void act('start')} title="起動">▶</button>}
              {running && <button disabled={busy} onClick={() => void act('stop')} title="停止">■</button>}
              <button disabled={busy} onClick={() => void act('restart')} title="再起動">↻</button>
              <button disabled={busy} onClick={onShowLogs} title="ログ">≡</button>
            </>
          )}
          {hasRepo && <button disabled={busy} onClick={() => void update_()} title="git pull">⇩</button>}
          {hasRepo && <button disabled={busy} onClick={() => void toggleBranch()} title="ブランチ">⎇</button>}
          <button className={`corpus-toggle ${usesCorpus ? 'on' : ''}`} onClick={() => void toggleCorpus()} title="Corpus 連携">
            Corpus
          </button>
        </div>
        {running && (
          <div className="svc-row-metrics">
            <MetricGraph
              label="稼働率" color="#34d399"
              points={(live?.series ?? []).map((s) => ({ t: s.t, v: s.ok * 100 }))}
              value={live?.uptime_ratio != null ? `${Math.round(live.uptime_ratio * 100)}%` : '—'}
            />
            <MetricGraph
              label="CPU" color="#f59e0b"
              points={(mem?.cpu_spark ?? []).map((s) => ({ t: s.t, v: s.cpu }))}
              value={mem?.cpu_pct != null ? `${mem.cpu_pct}%` : '—'}
            />
            <MetricGraph
              label="メモリ" color="#60a5fa"
              points={(mem?.spark ?? []).map((s) => ({ t: s.t, v: s.rss }))}
              value={mem?.rss_bytes != null ? fmtMiB(mem.rss_bytes) + (memPct != null ? ` (${memPct.toFixed(0)}%)` : '') : '—'}
            />
          </div>
        )}
      </div>

      {showBranch && (
        <div className="cc-branch">
          {branch === null ? <span className="muted">読み込み中…</span> : (
            <>
              <span>現在 <code>{branch.current ?? '—'}</code>
                {branch.ahead > 0 && <span className="ahead"> ↑{branch.ahead}</span>}
                {branch.behind > 0 && <span className="behind"> ↓{branch.behind}</span>}
                {branch.dirty && <span className="dirty-flag"> (dirty)</span>}
              </span>
              <span className="cc-branch-list">
                {branch.branches.map((b) => (
                  <span key={`${b.remote ? 'r' : 'l'}:${b.name}`} className={`branch-pill ${b.current ? 'current' : ''} ${b.remote ? 'remote' : 'local'}`}>
                    {b.remote ? `origin/${b.name}` : b.name}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtMiB(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(0)}MiB`;
}
