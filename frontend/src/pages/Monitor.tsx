import { useEffect, useMemo, useState } from 'react';
import type {
  Project, Component, ControlAction, PortReport, ServicePortStatus,
  LaunchPlan, MemoryCard, UpdateStatus, DiscoveryResult, LivenessSeries,
  CommitInfo, RecentLogLine,
} from '../lib/api';
import {
  fetchProjects, controlService, fetchPorts, setCorpusPref, applyUpdate,
  fetchLaunchPlan, saveLaunchProfile, launchStart, launchStop,
  fetchMemorySummary, fetchUpdates, fetchDiscovery, scanCatalog, fetchLiveness,
  fetchCommits, fetchRecentLogs, emergencyService,
} from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';
import MetricGraph from '../components/MetricGraph';

const RUNNING_STATES = new Set(['running', 'pending']);

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
    return all.sort((a, b) => {
      const ar = projectRunning(a) ? 0 : 1;
      const br = projectRunning(b) ? 0 : 1;
      if (ar !== br) return ar - br;
      return projectDisplayName(a).localeCompare(projectDisplayName(b));
    });
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
          c={detailFor}
          port={primaryPortStatus(detailFor, portsByCode.get(detailFor.code) ?? [])}
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
        <span className={`dot ${running ? 'running' : 'stopped'}`} title={running ? 'all running' : 'one or more components down'} />
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
  const running = c.state === 'running';
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
    <div className={`component-status-line ${c.state} ${c.disabled ? 'disabled' : ''}`}>
      <button className="component-status-main" onClick={onShowDetail}>
        <span className={`dot ${c.state}`} title={c.state} />
        <span className="component-status-role">{componentLabel(c)}</span>
        <span className={`state-badge ${c.state}`}>{c.state}</span>
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
          {c.runtime && <span className="tag">{c.runtime}</span>}
          {url && running && <a className="svc-url" href={url} target="_blank" rel="noreferrer">{shortUrl(url)}</a>}
          {update?.available && <span className="tag upd" title={`behind ${update.behind}`}>update</span>}
      </div>
      <div className="svc-row-actions">
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
  const [usesCorpus, setUsesCorpus] = useState<boolean>(c.uses_corpus ?? false);
  const [live, setLive] = useState<LivenessSeries | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [logs, setLogs] = useState<RecentLogLine[]>([]);
  const running = c.state === 'running';
  const isControllable = !c.disabled && ['node', 'dev-process-md', 'app', 'docker-compose', 'docker'].includes(c.runtime ?? '');
  const url = frontendUrl(c);

  useEffect(() => setUsesCorpus(c.uses_corpus ?? false), [c.uses_corpus]);
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
  const toggleCorpus = async () => {
    const next = !usesCorpus;
    setUsesCorpus(next);
    try { await setCorpusPref(c.code, next); } catch { setUsesCorpus(!next); }
  };

  return (
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
            <span className={`state-badge ${c.state}`}>{c.state}</span>
            {c.disabled && <span className="tag disabled">disabled</span>}
            {c.runtime && <span className="tag">{c.runtime}</span>}
            {c.port && <span className={`cc-port ${port?.conflict ? 'conflict' : ''}`}>:{c.port}</span>}
            {url && <a className="svc-url" href={url} target="_blank" rel="noreferrer">{url}</a>}
          </div>
        </section>

        <section className="detail-section">
          <h3>Controls</h3>
          <div className="detail-actions">
            {isControllable && !running && <button className="start" disabled={busy} onClick={() => void act('start')}>Start</button>}
            {isControllable && running && <button disabled={busy} onClick={() => void act('stop')}>Stop</button>}
            {isControllable && <button disabled={busy} onClick={() => void act('restart')}>Restart</button>}
            <button disabled={busy} onClick={() => void update_()}>Update</button>
            <button onClick={onShowLogs}>Live logs</button>
          </div>
        </section>

        <section className="detail-grid">
          <div className="detail-section">
            <h3>Metrics</h3>
            <MetricGraph label="Liveness" color="#34d399" points={(live?.series ?? []).map((s) => ({ t: s.t, v: s.ok * 100 }))} value={live?.uptime_ratio != null ? `${Math.round(live.uptime_ratio * 100)}%` : '-'} />
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
          <h3>Corpus / Settings</h3>
          <div className="detail-settings">
            <label><input type="checkbox" checked={usesCorpus} onChange={() => void toggleCorpus()} /> Use Corpus</label>
            <span>Domain: <code>{c.domain ?? '-'}</code></span>
            <span>Frontend URL: <code>{url ?? '-'}</code></span>
            <span>Start script: <code>{c.start_script ?? '-'}</code></span>
            <span>Log path: <code>{c.log_path ?? '-'}</code></span>
            <span>Autostart: <code>{String(c.autostart ?? false)}</code></span>
          </div>
        </section>
      </div>
    </div>
  );
}

function frontendUrl(c: Component): string | null {
  if (c.frontend_url) return c.frontend_url;
  if (c.domain) return c.domain.startsWith('http') ? c.domain : `https://${c.domain}`;
  return null;
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function fmtMiB(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(0)}MiB`;
}

function memoryPct(mem: MemoryCard | undefined): number | null {
  const total = mem?.detail?.['totalMemBytes'];
  return mem?.rss_bytes != null && typeof total === 'number' && total > 0 ? (mem.rss_bytes / total) * 100 : null;
}

function projectRunning(project: Project): boolean {
  return project.components.length > 0 && project.components.every((c) => c.state === 'running');
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
