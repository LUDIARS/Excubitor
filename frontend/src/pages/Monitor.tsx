import { useEffect, useMemo, useState } from 'react';
import type {
  Project, Component, ControlAction, PortReport, ServicePortStatus,
  LaunchPlan, MemoryCard, UpdateStatus, DiscoveryResult, LivenessSeries,
  CommitInfo, RecentLogLine, ServiceEnvConfig,
} from '../lib/api';
import {
  fetchProjects, controlService, fetchPorts, setCorpusPref, applyUpdate,
  fetchLaunchPlan, saveLaunchProfile, launchStart, launchStop,
  fetchMemorySummary, fetchUpdates, fetchDiscovery, scanCatalog, fetchLiveness,
  fetchCommits, fetchRecentLogs, emergencyService, saveCatalogInfo,
  fetchServiceEnvConfig, saveServiceEnvConfig,
} from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';
import MetricGraph from '../components/MetricGraph';

const RUNNING_STATES = new Set(['running', 'pending']);
const HEALTH_STALE_MS = 90_000;

export default function Monitor() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [ports, setPorts] = useState<PortReport | null>(null);
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [memByCode, setMemByCode] = useState<Map<string, MemoryCard>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [logsOpenFor, setLogsOpenFor] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<Component | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
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
  const portsByCode = useMemo(
    () => groupPortStatuses(ports?.services ?? []),
    [ports],
  );
  const rows = useMemo(() => {
    const all = projects ?? [];
    return [...all].sort(compareProjects);
  }, [projects]);

  const codes = useMemo(() => Array.from(selection), [selection]);

  const toggleSelect = (code: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

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
    setMsg(`Saved launch set (${codes.length}, auto ${autoLaunch ? 'on' : 'off'})`);
  });
  const doStartSet = () => run('start', async () => {
    await saveLaunchProfile(codes, autoLaunch);
    const r = await launchStart(codes);
    setMsg(`Started ${r.results.filter((x) => x.ok).length}/${r.results.length}`);
    await reloadCore();
  });
  const doStopSet = () => run('stop', async () => {
    await launchStop(codes);
    setMsg('Stopped selected services');
    await reloadCore();
  });
  const doCheckUpdates = () => run('updates', async () => {
    const list = await fetchUpdates(true);
    setUpdates(new Map(list.map((u) => [u.code, u])));
    setMsg(`Updates available: ${list.filter((u) => u.available).length}`);
  });
  const doScan = () => run('scan', async () => {
    const r = await scanCatalog();
    setMsg(`Scan complete: created ${r.created.length}, ports ${Object.keys(r.ports).length}, skipped ${r.skipped.length}`);
    await Promise.all([reloadCore(), reloadPlan().catch(() => {}), fetchDiscovery().then(setDiscovery).catch(() => {})]);
  });

  return (
    <div className="monitor">
      {error && <div className="error-banner">Error: {error}</div>}
      {msg && <div className="launcher-msg">{msg}</div>}
      {ports?.hasConflict && (
        <div className="error-banner">
          Port conflicts: {ports.services.filter((s) => s.conflict).map((s) => `${s.code}(:${s.port})`).join(', ')}
        </div>
      )}

      <div className="monitor-bar">
        <div className="monitor-bar-info">
          <strong>{selection.size}</strong> selected
          <label className="auto-launch">
            <input type="checkbox" checked={autoLaunch} onChange={(e) => setAutoLaunch(e.target.checked)} /> auto launch
          </label>
        </div>
        <div className="monitor-bar-actions">
          <button disabled={busy !== null} onClick={doSave}>{busy === 'save' ? 'Saving...' : 'Save set'}</button>
          <button className="primary" disabled={busy !== null || selection.size === 0} onClick={doStartSet}>
            {busy === 'start' ? 'Starting...' : `Start (${selection.size})`}
          </button>
          <button disabled={busy !== null} onClick={doStopSet}>{busy === 'stop' ? 'Stopping...' : 'Stop set'}</button>
          <span className="bar-sep" />
          <button disabled={busy !== null} onClick={doCheckUpdates}>{busy === 'updates' ? 'Checking...' : 'Check updates'}</button>
          <button disabled={busy !== null} onClick={doScan}>{busy === 'scan' ? 'Scanning...' : 'Scan catalog'}</button>
        </div>
      </div>

      {discovery && discovery.candidates.length > 0 && (
        <div className="discovery-strip">
          Unregistered: {discovery.candidates.slice(0, 8).map((d) => d.name).join(', ')}
          {discovery.candidates.length > 8 ? ' ...' : ''}
        </div>
      )}

      {projects === null && <div className="empty-state">Loading...</div>}
      {projects !== null && rows.length === 0 && <div className="empty-state">No services registered.</div>}

      <div className="svc-rows">
        {rows.map((project) => (
          <ProjectRow
            key={project.project_code}
            project={project}
            portsByCode={portsByCode}
            memByCode={memByCode}
            updates={updates}
            startableSet={startableSet}
            selection={selection}
            onToggleSelect={toggleSelect}
            onShowLogs={setLogsOpenFor}
            onShowDetail={setDetailFor}
            onChanged={reloadCore}
          />
        ))}
      </div>

      {detailFor && (
        <ServiceDetailOverlay
          c={latestComponent(projects, detailFor.code) ?? detailFor}
          port={primaryPortStatus(latestComponent(projects, detailFor.code) ?? detailFor, portsByCode.get(detailFor.code) ?? [])}
          mem={memByCode.get(detailFor.code)}
          update={updates.get(detailFor.code)}
          onClose={() => setDetailFor(null)}
          onChanged={reloadCore}
          onShowLogs={() => setLogsOpenFor(detailFor.code)}
        />
      )}
      {logsOpenFor && <LogsDrawer code={logsOpenFor} onClose={() => setLogsOpenFor(null)} />}
    </div>
  );
}

function ProjectRow({
  project, portsByCode, memByCode, updates, startableSet, selection,
  onToggleSelect, onShowLogs, onShowDetail, onChanged,
}: {
  project: Project;
  portsByCode: Map<string, ServicePortStatus[]>;
  memByCode: Map<string, MemoryCard>;
  updates: Map<string, UpdateStatus>;
  startableSet: Set<string>;
  selection: Set<string>;
  onToggleSelect: (code: string) => void;
  onShowLogs: (code: string) => void;
  onShowDetail: (c: Component) => void;
  onChanged: () => Promise<void>;
}) {
  const components = [...project.components].sort(componentSort);
  const primary = components.find((c) => c.component === 'frontend') ?? components[0]!;
  const branch = components.find((c) => c.git.branch)?.git;
  const rowState = projectRunning(project) ? 'running' : 'stopped';
  const running = rowState === 'running';
  return (
    <div className={`svc-row ${rowState} ${components.every((c) => c.disabled) ? 'disabled' : ''}`}>
      <div className="svc-row-main project-row-main">
        <span className={`dot ${running ? 'running' : 'stopped'}`} title={running ? 'one or more components running' : 'no running components'} />
        <div className="project-row-selects">
          {components.map((c) => (
            <label key={c.code} className="svc-row-select" title={startableSet.has(c.code) ? 'include in launch set' : 'not startable'}>
              <input
                type="checkbox"
                disabled={!startableSet.has(c.code)}
                checked={selection.has(c.code)}
                onChange={() => onToggleSelect(c.code)}
              />
            </label>
          ))}
        </div>
        <button className="svc-name-button project-name-button" onClick={() => onShowDetail(primary)}>
          <span className="svc-row-name">{projectDisplayName(project)}</span>
          <span className="svc-row-code">{branch?.branch ? `${branch.branch}${branch.dirty ? ' *' : ''}` : '-'}</span>
        </button>
        <div className="project-component-statuses">
          {components.map((c) => (
            <ComponentStatusLine
              key={c.code}
              c={c}
              portStatuses={portsByCode.get(c.code) ?? []}
              mem={memByCode.get(c.code)}
              update={updates.get(c.code)}
              onShowLogs={() => onShowLogs(c.code)}
              onShowDetail={() => onShowDetail(c)}
              onChanged={onChanged}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ComponentStatusLine({
  c, portStatuses, mem, update, onShowLogs, onShowDetail, onChanged,
}: {
  c: Component;
  portStatuses: ServicePortStatus[];
  mem: MemoryCard | undefined;
  update: UpdateStatus | undefined;
  onShowLogs: () => void;
  onShowDetail: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [opsBusy, setOpsBusy] = useState(false);
  const displayState = componentDisplayState(c);
  const running = RUNNING_STATES.has(displayState);
  const healthTitle = componentHealthTitle(c, displayState);
  const isControllable = !c.disabled && ['node', 'dev-process-md', 'app', 'docker-compose', 'docker'].includes(c.runtime ?? '');
  const url = frontendUrl(c);
  const port = primaryPortStatus(c, portStatuses);

  const act = async (action: ControlAction) => {
    setBusy(true);
    try {
      const r = await controlService(c.code, action);
      if (!r.ok) alert(`${action} failed: ${r.stderr || r.stdout}`);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const emergency = async (action: 'kill-port' | 'claude-port-fix', portOverride?: number) => {
    setOpsBusy(true);
    try {
      const r = await emergencyService(c.code, action, undefined, portOverride);
      if (!r.ok) alert(`${action} failed: ${r.stderr || r.stdout}`);
      else alert(`${action}: ${r.stdout || `ok (${r.pids.join(', ') || 'no pid'})`}`);
      await onChanged();
    } finally {
      setOpsBusy(false);
    }
  };

  const memPct = memoryPct(mem);
  return (
    <div className={`component-status-line ${displayState} ${c.disabled ? 'disabled' : ''}`}>
      <button className="component-status-main" onClick={onShowDetail}>
        <span className={`dot ${displayState}`} title={healthTitle} />
        <span className="component-status-role">{componentLabel(c)}</span>
        <span className={`state-badge ${displayState}`} title={healthTitle}>{displayState}</span>
        <span className={`cc-port ${port?.conflict ? 'conflict' : ''}`}>{primaryPortLabel(c, port)}</span>
      </button>
      <div className="component-port-list">
        {managedPorts(c).map((p) => (
          <span className={`managed-port ${portStatusFor(p, portStatuses)?.conflict ? 'conflict' : ''}`} key={`${p.role}:${p.port}`}>
            {p.role}: {p.port}
            <button className="danger" disabled={opsBusy} onClick={() => void emergency('kill-port', p.port)}>Kill</button>
          </span>
        ))}
      </div>
      <div className="svc-row-tags component-status-tags">
          {c.disabled && <span className="tag disabled">disabled</span>}
          {displayState === 'stale' && <span className="tag health-stale" title={healthTitle}>health stale</span>}
          {c.health_ok === false && <span className="tag health-failed" title={healthTitle}>health fail</span>}
          {c.downtime_24h?.current_down_ms ? (
            <span className="tag health-failed" title={`down since ${new Date(c.downtime_24h.current_down_since ?? Date.now()).toLocaleString()}`}>
              down {fmtDuration(c.downtime_24h.current_down_ms)}
            </span>
          ) : c.downtime_24h && c.downtime_24h.downtime_ms > 0 ? (
            <span className="tag health-stale" title={`${c.downtime_24h.incidents} incident(s) in 24h`}>
              24h down {fmtDuration(c.downtime_24h.downtime_ms)}
            </span>
          ) : null}
          {c.runtime && <span className="tag">{c.runtime}</span>}
          {url && <a className="svc-url" href={url} target="_blank" rel="noreferrer">{shortUrl(url)}</a>}
          {update?.available && <span className="tag upd" title={`behind ${update.behind}`}>update</span>}
      </div>
      <div className="svc-row-actions">
          {url && <button disabled={busy} onClick={() => openFrontendUrl(url)}>Open</button>}
          {isControllable && !running && <button className="start" disabled={busy} onClick={() => void act('start')}>Start</button>}
          {isControllable && running && <button disabled={busy} onClick={() => void act('stop')}>Stop</button>}
          {isControllable && <button disabled={busy} onClick={() => void act('restart')}>Restart</button>}
          {managedPorts(c).length > 0 && <button disabled={opsBusy} onClick={() => void emergency('claude-port-fix')}>Claude ops</button>}
          <button disabled={busy} onClick={onShowLogs}>Logs</button>
      </div>
      {running && (
        <div className="svc-row-metrics">
          <MetricGraph label="CPU" color="#f59e0b" points={(mem?.cpu_spark ?? []).map((s) => ({ t: s.t, v: s.cpu }))} value={mem?.cpu_pct != null ? `${mem.cpu_pct}%` : '-'} />
          <MetricGraph label="Memory" color="#60a5fa" points={(mem?.spark ?? []).map((s) => ({ t: s.t, v: s.rss }))} value={mem?.rss_bytes != null ? fmtMiB(mem.rss_bytes) + (memPct != null ? ` (${memPct.toFixed(0)}%)` : '') : '-'} />
        </div>
      )}
    </div>
  );
}

function ServiceDetailOverlay({
  c, port, mem, update, onClose, onChanged, onShowLogs,
}: {
  c: Component;
  port: ServicePortStatus | undefined;
  mem: MemoryCard | undefined;
  update: UpdateStatus | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onShowLogs: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [live, setLive] = useState<LivenessSeries | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [logs, setLogs] = useState<RecentLogLine[]>([]);
  const displayState = componentDisplayState(c);
  const running = RUNNING_STATES.has(displayState);
  const healthTitle = componentHealthTitle(c, displayState);
  const isControllable = !c.disabled && ['node', 'dev-process-md', 'app', 'docker-compose', 'docker'].includes(c.runtime ?? '');
  const url = frontendUrl(c);
  const usesCorpus = c.uses_corpus ?? false;

  useEffect(() => {
    let stop = false;
    void fetchLiveness(c.code, 120).then((v) => { if (!stop) setLive(v); }).catch(() => {});
    void fetchCommits(c.code, 8).then((v) => { if (!stop) setCommits(v); }).catch(() => {});
    void fetchRecentLogs(c.code, 80).then((v) => { if (!stop) setLogs(v); }).catch(() => {});
    return () => { stop = true; };
  }, [c.code]);

  const act = async (action: ControlAction) => {
    setBusy(true);
    try {
      const r = await controlService(c.code, action);
      if (!r.ok) alert(`${action} failed: ${r.stderr || r.stdout}`);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const update_ = async () => {
    setBusy(true);
    try {
      const r = await applyUpdate(c.code, { install: true, restart: running });
      if (!r.ok) alert(`Update failed: ${r.steps.find((s) => !s.ok)?.detail ?? 'unknown'}`);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="detail-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
          <header className="detail-head">
            <div>
              <h2>{c.name}</h2>
              <div className="detail-sub">{c.code} {c.component ? `/${c.component}` : ''}</div>
            </div>
            <button className="close" onClick={onClose}>Close</button>
          </header>

          <section className="detail-section">
            <h3>Overview</h3>
            <p>{c.description || 'No description in catalog.'}</p>
            <div className="detail-tags">
              <span className={`state-badge ${displayState}`} title={healthTitle}>{displayState}</span>
              {displayState === 'stale' && <span className="tag health-stale" title={healthTitle}>health stale</span>}
              {c.health_ok === false && <span className="tag health-failed" title={healthTitle}>health fail</span>}
              {c.disabled && <span className="tag disabled">disabled</span>}
              {c.runtime && <span className="tag">{c.runtime}</span>}
              {c.port && <span className={`cc-port ${port?.conflict ? 'conflict' : ''}`}>:{c.port}</span>}
              {url && <a className="svc-url" href={url} target="_blank" rel="noreferrer">{url}</a>}
            </div>
          </section>

          <section className="detail-section">
            <h3>Controls</h3>
            <div className="detail-actions">
              {url && <button disabled={busy} onClick={() => openFrontendUrl(url)}>Open frontend</button>}
              {isControllable && !running && <button className="start" disabled={busy} onClick={() => void act('start')}>Start</button>}
              {isControllable && running && <button disabled={busy} onClick={() => void act('stop')}>Stop</button>}
              {isControllable && <button disabled={busy} onClick={() => void act('restart')}>Restart</button>}
              <button disabled={busy} onClick={() => setEnvOpen(true)}>ENV</button>
              <button disabled={busy} onClick={() => void update_()}>Update</button>
              <button onClick={onShowLogs}>Live logs</button>
            </div>
          </section>

          <section className="detail-grid">
            <div className="detail-section">
              <h3>Metrics</h3>
              <MetricGraph label="Liveness" color="#34d399" points={(live?.series ?? []).map((s) => ({ t: s.t, v: s.ok * 100 }))} value={live?.uptime_ratio != null ? `${Math.round(live.uptime_ratio * 100)}%` : '-'} />
              <MetricGraph label="Downtime" color="#ef4444" points={(live?.series ?? []).map((s) => ({ t: s.t, v: s.ok ? 0 : 100 }))} value={live?.downtime ? fmtDuration(live.downtime.downtime_ms) : '-'} />
              <MetricGraph label="CPU" color="#f59e0b" points={(mem?.cpu_spark ?? []).map((s) => ({ t: s.t, v: s.cpu }))} value={mem?.cpu_pct != null ? `${mem.cpu_pct}%` : '-'} />
              <MetricGraph label="Memory" color="#60a5fa" points={(mem?.spark ?? []).map((s) => ({ t: s.t, v: s.rss }))} value={mem?.rss_bytes != null ? fmtMiB(mem.rss_bytes) : '-'} />
            </div>
            <div className="detail-section">
              <h3>CPU / Memory</h3>
              <dl className="detail-kv">
                <dt>PID</dt><dd>{mem?.pid ?? '-'}</dd>
                <dt>RSS</dt><dd>{mem?.rss_bytes != null ? fmtMiB(mem.rss_bytes) : '-'}</dd>
                <dt>Heap used</dt><dd>{mem?.heap_used_bytes != null ? fmtMiB(mem.heap_used_bytes) : '-'}</dd>
                <dt>Heap total</dt><dd>{mem?.heap_total_bytes != null ? fmtMiB(mem.heap_total_bytes) : '-'}</dd>
                <dt>CPU</dt><dd>{mem?.cpu_pct != null ? `${mem.cpu_pct}%` : '-'}</dd>
                <dt>Leak</dt><dd>{mem?.leak.verdict ?? '-'}</dd>
                <dt>Downtime</dt><dd>{live?.downtime ? fmtDuration(live.downtime.downtime_ms) : '-'}</dd>
                <dt>Incidents</dt><dd>{live?.downtime?.incidents ?? '-'}</dd>
                <dt>Current down</dt><dd>{live?.downtime?.current_down_ms ? fmtDuration(live.downtime.current_down_ms) : '-'}</dd>
              </dl>
            </div>
          </section>

          <section className="detail-grid">
            <div className="detail-section">
              <h3>Logs</h3>
              <div className="detail-log-list">
                {logs.length === 0 && <span className="muted">No recent logs.</span>}
                {logs.slice(0, 12).map((l) => <div className="detail-log" key={l.id}>{String(l.line)}</div>)}
              </div>
            </div>
            <div className="detail-section">
              <h3>GitHub Logs</h3>
              <div className="commit-list">
                {commits.length === 0 && <span className="muted">No commits available.</span>}
                {commits.map((cm) => (
                  <div className="commit-row" key={cm.hash}>
                    <code>{cm.hash}</code>
                    <span className="commit-subject">{cm.subject}</span>
                    <span className="commit-rel">{cm.relative}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="detail-section">
            <h3>Catalog</h3>
            <div className="detail-settings">
              <button disabled={busy} onClick={() => setCatalogOpen(true)}>Edit catalog</button>
              <label className="catalog-checkbox">
                <input type="checkbox" checked={usesCorpus} disabled readOnly />
                Use Corpus
              </label>
            </div>
          </section>
        </div>
      </div>
      {catalogOpen && (
        <CatalogEditWindow
          c={c}
          onClose={() => setCatalogOpen(false)}
          onSaved={async () => {
            setCatalogOpen(false);
            await onChanged();
          }}
        />
      )}
      {envOpen && (
        <EnvConfigWindow
          c={c}
          onClose={() => setEnvOpen(false)}
          onSaved={async () => {
            setEnvOpen(false);
            await onChanged();
          }}
        />
      )}
    </>
  );
}

function EnvConfigWindow({
  c, onClose, onSaved,
}: {
  c: Component;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [cfg, setCfg] = useState<ServiceEnvConfig | null>(null);
  const [projectId, setProjectId] = useState('');
  const [environment, setEnvironment] = useState('dev');
  const [inject, setInject] = useState(true);
  const [prefix, setPrefix] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [requiredEnv, setRequiredEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    const next = await fetchServiceEnvConfig(c.code);
    const source = next.override ?? next.effective;
    setCfg(next);
    setProjectId(source?.project_id ?? '');
    setEnvironment(source?.environment ?? 'dev');
    setInject(source?.inject ?? true);
    setPrefix(source?.prefix ?? '');
    setInclude(joinList(source?.include));
    setExclude(joinList(source?.exclude));
    setRequiredEnv(joinList(source?.required_env ?? next.required_env));
  };

  useEffect(() => {
    void load().catch((e: unknown) => setError((e as Error).message));
  }, [c.code]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveServiceEnvConfig(c.code, {
        project_id: projectId,
        environment,
        inject,
        prefix,
        include: splitList(include),
        exclude: splitList(exclude),
        required_env: splitList(requiredEnv),
      });
      await onSaved();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="catalog-window-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <form
        className="catalog-window env-window"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="catalog-window-head">
          <div>
            <h3>Infisical ENV</h3>
            <div className="detail-sub">{c.code}</div>
          </div>
          <button type="button" className="close" onClick={onClose}>Close</button>
        </header>
        {error && <div className="error-banner">Error: {error}</div>}
        {cfg && (
          <div className={`env-status ${cfg.status.ready ? 'ok' : 'fail'}`}>
            {cfg.status.ready ? 'ready' : 'missing'} | required {cfg.status.required.length} | resolved {cfg.status.resolvedKeys ?? '-'}
            {cfg.status.missing.length > 0 && <span> | {cfg.status.missing.join(', ')}</span>}
            {cfg.status.error && <span> | {cfg.status.error}</span>}
          </div>
        )}
        <label>
          Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Infisical project UUID" />
        </label>
        <div className="env-window-grid">
          <label>
            Environment
            <input value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </label>
          <label>
            Prefix
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </label>
        </div>
        <label className="catalog-checkbox">
          <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} />
          Inject into service process
        </label>
        <label>
          Required env
          <textarea value={requiredEnv} onChange={(e) => setRequiredEnv(e.target.value)} placeholder="ONE_KEY, ANOTHER_KEY" />
        </label>
        <div className="env-window-grid">
          <label>
            Include
            <textarea value={include} onChange={(e) => setInclude(e.target.value)} />
          </label>
          <label>
            Exclude
            <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} />
          </label>
        </div>
        <div className="catalog-window-actions">
          <button type="submit" className="primary" disabled={busy || (inject && !projectId.trim())}>
            {busy ? 'Saving...' : 'Save ENV'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function CatalogEditWindow({
  c, onClose, onSaved,
}: {
  c: Component;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [projectCode, setProjectCode] = useState(c.project_code ?? c.code);
  const [subdomain, setSubdomain] = useState(c.subdomain ?? '');
  const [usesCorpus, setUsesCorpus] = useState(c.uses_corpus ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProjectCode(c.project_code ?? c.code);
    setSubdomain(c.subdomain ?? '');
    setUsesCorpus(c.uses_corpus ?? false);
  }, [c.code, c.project_code, c.subdomain, c.uses_corpus]);

  const saveInfo = async () => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([
        saveCatalogInfo(c.code, {
          project_code: projectCode,
          subdomain,
        }),
        setCorpusPref(c.code, usesCorpus),
      ]);
      await onSaved();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="catalog-window-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <form
        className="catalog-window"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void saveInfo();
        }}
      >
        <header className="catalog-window-head">
          <div>
            <h3>Edit catalog</h3>
            <div className="detail-sub">{c.code}</div>
          </div>
          <button type="button" className="close" onClick={onClose}>Close</button>
        </header>
        {error && <div className="error-banner">Error: {error}</div>}
        <label>
          Project code
          <input value={projectCode} onChange={(e) => setProjectCode(e.target.value)} />
        </label>
        <label>
          Subdomain
          <input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="example" />
        </label>
        <label className="catalog-checkbox">
          <input type="checkbox" checked={usesCorpus} onChange={(e) => setUsesCorpus(e.target.checked)} />
          Use Corpus
        </label>
        <div className="catalog-window-actions">
          <button type="submit" className="primary" disabled={busy || !projectCode.trim()}>
            {busy ? 'Saving...' : 'Save catalog'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function frontendUrl(c: Component): string | null {
  if (c.frontend_url) return normalizeFrontendUrl(c.frontend_url);
  if (c.domain) return normalizeFrontendUrl(c.domain);
  if (c.code === 'excubitor') return window.location.origin;
  if (c.component === 'frontend' && c.port) return `http://localhost:${c.port}`;
  return null;
}

function normalizeFrontendUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function openFrontendUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function joinList(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

function latestComponent(projects: Project[] | null, code: string): Component | null {
  return projects?.flatMap((p) => p.components).find((c) => c.code === code) ?? null;
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function fmtMiB(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(0)}MiB`;
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

function memoryPct(mem: MemoryCard | undefined): number | null {
  const total = mem?.detail?.['totalMemBytes'];
  return mem?.rss_bytes != null && typeof total === 'number' && total > 0 ? (mem.rss_bytes / total) * 100 : null;
}

function projectRunning(project: Project): boolean {
  return project.components.some((c) => RUNNING_STATES.has(componentDisplayState(c)));
}

function componentDisplayState(c: Component): string {
  const hasHealth = c.health_ok === true || c.health_ok === false;
  const age = healthAgeMs(c);
  if (hasHealth && age != null && age > HEALTH_STALE_MS) return 'stale';
  if (c.health_ok === true) return 'running';
  if (c.health_ok === false) return 'stopped';
  return c.state || 'unknown';
}

function componentHealthTitle(c: Component, displayState = componentDisplayState(c)): string {
  const parts = [`status: ${displayState}`];
  if (c.health_ok === true) parts.push('health: ok');
  if (c.health_ok === false) parts.push('health: failed');
  if (c.health_reason) parts.push(`reason: ${c.health_reason}`);
  if (c.health_detail) parts.push(c.health_detail);
  if (typeof c.health_checked_at === 'number') {
    parts.push(`checked: ${new Date(c.health_checked_at).toLocaleString()}`);
  }
  return parts.join(' / ');
}

function healthAgeMs(c: Component): number | null {
  return typeof c.health_checked_at === 'number' ? Date.now() - c.health_checked_at : null;
}

function compareProjects(a: Project, b: Project): number {
  const ac = projectCatalogInfoComplete(a) ? 0 : 1;
  const bc = projectCatalogInfoComplete(b) ? 0 : 1;
  if (ac !== bc) return ac - bc;
  const al = projectLastSeenAt(a);
  const bl = projectLastSeenAt(b);
  if (al !== bl) return bl - al;
  return projectDisplayName(a).localeCompare(projectDisplayName(b));
}

function projectCatalogInfoComplete(project: Project): boolean {
  const frontend = project.components.find((c) => c.frontend_url || c.domain || c.subdomain);
  if (!frontend) return false;
  return Boolean(frontend.project_code && frontend.subdomain && frontend.domain);
}

function projectLastSeenAt(project: Project): number {
  return Math.max(0, ...project.components.map((c) => c.last_seen_at ?? 0));
}

function projectDisplayName(project: Project): string {
  const explicit = project.project_name && project.project_name !== project.project_code ? project.project_name : null;
  const named = project.components.find((c) => c.name && c.name.toLowerCase() !== c.code.toLowerCase())?.name;
  return explicit ?? named ?? project.project_code;
}

function componentLabel(c: Component): string {
  return (c.component ?? 'service').replace(/^\w/, (s) => s.toUpperCase());
}

function componentSort(a: Component, b: Component): number {
  const weight = (c: Component) => c.component === 'frontend' ? 0 : c.component === 'backend' ? 1 : 2;
  const d = weight(a) - weight(b);
  return d !== 0 ? d : a.code.localeCompare(b.code);
}

function managedPorts(c: Component): Array<{ role: string; port: number }> {
  const out: Array<{ role: string; port: number }> = [];
  const seen = new Set<number>();
  const add = (role: string, port: number | null | undefined) => {
    if (typeof port !== 'number' || seen.has(port)) return;
    seen.add(port);
    out.push({ role, port });
  };
  add(c.component ?? 'service', c.port);
  add('frontend', c.frontend_port);
  add('backend', c.backend_port);
  for (const p of c.ports ?? []) add(p.role, p.port);
  return out;
}

function primaryPortLabel(c: Component, port: ServicePortStatus | undefined): string {
  if (c.port) return `:${c.port}`;
  const first = managedPorts(c)[0];
  return first ? `:${first.port}` : (port ? `:${port.port}` : '-');
}

function groupPortStatuses(list: ServicePortStatus[]): Map<string, ServicePortStatus[]> {
  const map = new Map<string, ServicePortStatus[]>();
  for (const item of list) {
    const arr = map.get(item.code) ?? [];
    arr.push(item);
    map.set(item.code, arr);
  }
  return map;
}

function primaryPortStatus(c: Component, statuses: ServicePortStatus[]): ServicePortStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (c.port != null) return statuses.find((s) => s.port === c.port) ?? statuses[0];
  const first = managedPorts(c)[0];
  return first ? portStatusFor(first, statuses) ?? statuses[0] : statuses[0];
}

function portStatusFor(
  port: { role: string; port: number },
  statuses: ServicePortStatus[],
): ServicePortStatus | undefined {
  return statuses.find((s) => s.port === port.port && s.role === port.role)
    ?? statuses.find((s) => s.port === port.port);
}
