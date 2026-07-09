import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchErrorTasks,
  fetchFunctionMetrics,
  fetchLaunchPlan,
  fetchMemorySummary,
  fetchPorts,
  fetchProjects,
  type Component,
  type ErrorTask,
  type FunctionMetricAggregate,
  type LaunchPlan,
  type MemoryCard,
  type PlanService,
  type PortReport,
  type Project,
  type ServicePortStatus,
} from '../lib/api';

const FAVORITES_STORAGE_KEY = 'excubitor.dashboard.favoriteServiceCodes';
const RUNNING_STATES = new Set(['running', 'pending']);
const METRIC_POLL_STATES = new Set(['running', 'pending', 'stale']);
const HEALTH_STALE_MS = 90_000;

interface DashboardService {
  project: Project;
  component: Component;
}

interface MetricStatus {
  code: string;
  checkedAt: number;
  calls: number | null;
  errors: number | null;
  sourceUrl: string | null;
  requestError: string | null;
  rows: FunctionMetricAggregate[];
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [ports, setPorts] = useState<PortReport | null>(null);
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [memByCode, setMemByCode] = useState<Map<string, MemoryCard>>(new Map());
  const [errorTasks, setErrorTasks] = useState<ErrorTask[]>([]);
  const [metricsByCode, setMetricsByCode] = useState<Map<string, MetricStatus>>(new Map());
  const [favoriteCodes, setFavoriteCodes] = useState<Set<string>>(() => loadFavorites());
  const [favoriteDraft, setFavoriteDraft] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const metricRun = useRef(0);

  const reloadCore = async () => {
    setRefreshing(true);
    try {
      const [projectList, portReport, launchPlan, memory, tasks] = await Promise.all([
        fetchProjects(),
        fetchPorts().catch(() => null),
        fetchLaunchPlan().catch(() => null),
        fetchMemorySummary().catch(() => null),
        fetchErrorTasks('open').catch(() => []),
      ]);
      setProjects(projectList);
      setPorts(portReport);
      setPlan(launchPlan);
      if (memory) setMemByCode(new Map(memory.services.map((s) => [s.target_key, s])));
      setErrorTasks(tasks);
      setError(null);
      void reloadMetrics(projectList);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const reloadMetrics = async (projectList: Project[]) => {
    const runId = ++metricRun.current;
    setMetricsBusy(true);
    const statuses = await loadMetricStatuses(projectList);
    if (metricRun.current === runId) {
      setMetricsByCode(new Map(statuses.map((s) => [s.code, s])));
      setMetricsBusy(false);
    }
  };

  useEffect(() => {
    void reloadCore();
    const id = window.setInterval(() => void reloadCore(), 10000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    saveFavorites(favoriteCodes);
  }, [favoriteCodes]);

  const allServices = useMemo(() => flattenServices(projects ?? []), [projects]);
  const services = useMemo(
    () => allServices.filter((s) => shouldShowOnDashboard(s.component, favoriteCodes)),
    [allServices, favoriteCodes],
  );
  const favoriteCandidates = useMemo(
    () => allServices.filter((s) => !favoriteCodes.has(s.component.code)),
    [allServices, favoriteCodes],
  );
  const portsByCode = useMemo(() => groupPortStatuses(ports?.services ?? []), [ports]);
  const launchByCode = useMemo(() => launchServiceMap(plan), [plan]);
  const errorsByCode = useMemo(() => groupErrorTasks(errorTasks), [errorTasks]);

  useEffect(() => {
    if (services.length === 0) {
      setSelectedCode(null);
      return;
    }
    if (selectedCode && services.some((s) => s.component.code === selectedCode)) return;
    const needsAttention = services.find((s) => serviceNeedsAttention(s.component, metricsByCode.get(s.component.code), errorsByCode.get(s.component.code)));
    setSelectedCode((needsAttention ?? services[0]!).component.code);
  }, [services, selectedCode, metricsByCode, errorsByCode]);

  const selected = services.find((s) => s.component.code === selectedCode) ?? services[0] ?? null;
  const summary = buildSummary(services, metricsByCode, memByCode, errorTasks);

  const toggleFavorite = (code: string) => {
    setFavoriteCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const addFavorite = () => {
    if (!favoriteDraft) return;
    setFavoriteCodes((prev) => new Set(prev).add(favoriteDraft));
    setFavoriteDraft('');
  };

  return (
    <div className="dashboard-page">
      {error && <div className="error-banner">Error: {error}</div>}

      <div className="dashboard-head">
        <div>
          <h2>Dashboard</h2>
          <div className="dashboard-sub">Autostart, active, and favorite service operations.</div>
        </div>
        <div className="dashboard-head-actions">
          <select value={favoriteDraft} onChange={(e) => setFavoriteDraft(e.target.value)} aria-label="Add favorite service">
            <option value="">Add favorite...</option>
            {favoriteCandidates.map((s) => (
              <option key={s.component.code} value={s.component.code}>
                {s.component.code} / {s.component.name}
              </option>
            ))}
          </select>
          <button disabled={!favoriteDraft} onClick={addFavorite}>Add</button>
          <button disabled={refreshing} onClick={() => void reloadCore()}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="dashboard-summary">
        <SummaryTile label="CPU total" value={formatCpu(summary.cpuPct)} />
        <SummaryTile label="Memory total" value={formatBytes(summary.rssBytes)} />
        <SummaryTile label="Downtime 24h" value={fmtDuration(summary.downtimeMs)} tone={summary.downtimeMs > 0 ? 'warn' : undefined} />
        <SummaryTile label="Current downtime" value={fmtDuration(summary.currentDownMs)} tone={summary.currentDownMs > 0 ? 'bad' : undefined} />
        <SummaryTile label="Metric errors" value={summary.metricErrors} tone={summary.metricErrors > 0 ? 'bad' : undefined} />
        <SummaryTile label="Open errors" value={summary.openErrors} tone={summary.openErrors > 0 ? 'bad' : undefined} />
      </div>

      {projects === null && !error && <div className="empty-state">Loading...</div>}
      {projects !== null && allServices.length === 0 && <div className="empty-state">No services registered.</div>}
      {projects !== null && allServices.length > 0 && services.length === 0 && (
        <div className="empty-state">No dashboard targets. Enable autostart, start a service, or add a favorite.</div>
      )}

      {services.length > 0 && (
        <div className="dashboard-layout">
          <section className="dashboard-service-list">
            <div className="dashboard-list-head">
              <span>Targets</span>
              {metricsBusy && <span className="muted">metrics polling</span>}
            </div>
            {services.map((item) => (
              <ServiceListButton
                key={item.component.code}
                item={item}
                selected={item.component.code === selected?.component.code}
                favorite={favoriteCodes.has(item.component.code)}
                portStatuses={portsByCode.get(item.component.code) ?? []}
                mem={memByCode.get(item.component.code)}
                metric={metricsByCode.get(item.component.code)}
                errors={errorsByCode.get(item.component.code) ?? []}
                onSelect={() => setSelectedCode(item.component.code)}
                onToggleFavorite={() => toggleFavorite(item.component.code)}
              />
            ))}
          </section>

          <section className="dashboard-detail">
            {selected && (
              <ServiceDashboardDetail
                item={selected}
                launch={launchByCode.get(selected.component.code)}
                favorite={favoriteCodes.has(selected.component.code)}
                mem={memByCode.get(selected.component.code)}
                portStatuses={portsByCode.get(selected.component.code) ?? []}
                metric={metricsByCode.get(selected.component.code)}
                errors={errorsByCode.get(selected.component.code) ?? []}
                onToggleFavorite={() => toggleFavorite(selected.component.code)}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`dashboard-summary-tile ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ServiceListButton({
  item,
  selected,
  favorite,
  portStatuses,
  mem,
  metric,
  errors,
  onSelect,
  onToggleFavorite,
}: {
  item: DashboardService;
  selected: boolean;
  favorite: boolean;
  portStatuses: ServicePortStatus[];
  mem: MemoryCard | undefined;
  metric: MetricStatus | undefined;
  errors: ErrorTask[];
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  const c = item.component;
  const state = componentDisplayState(c);
  const port = primaryPortLabel(c, portStatuses);
  const metricTone = metricBadgeTone(c, metric);
  return (
    <div
      className={`dashboard-service-button ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
    >
      <button
        className={`dashboard-favorite-toggle ${favorite ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        title={favorite ? 'Remove favorite' : 'Add favorite'}
      >
        {favorite ? 'Fav' : '+'}
      </button>
      <span className={`dot ${state}`} title={componentHealthTitle(c, state)} />
      <span className="dashboard-service-main">
        <span className="dashboard-service-name">{c.name}</span>
        <span className="dashboard-service-meta">{c.code} / {projectDisplayName(item.project)}</span>
      </span>
      <span className="dashboard-service-side">
        <span className="dashboard-resource-badge">{resourceBadge(mem)}</span>
        <span className={`dashboard-metric-badge ${metricTone}`}>{metricBadgeLabel(c, metric)}</span>
        {errors.length > 0 && <span className="dashboard-error-count">{errors.length}</span>}
        <span className="cc-port">{port}</span>
      </span>
    </div>
  );
}

function ServiceDashboardDetail({
  item,
  launch,
  favorite,
  mem,
  portStatuses,
  metric,
  errors,
  onToggleFavorite,
}: {
  item: DashboardService;
  launch: PlanService | undefined;
  favorite: boolean;
  mem: MemoryCard | undefined;
  portStatuses: ServicePortStatus[];
  metric: MetricStatus | undefined;
  errors: ErrorTask[];
  onToggleFavorite: () => void;
}) {
  const c = item.component;
  const state = componentDisplayState(c);
  const healthTitle = componentHealthTitle(c, state);
  const metricRows = metric?.rows.filter((r) => r.errors > 0) ?? [];
  return (
    <>
      <div className="dashboard-detail-title">
        <div>
          <h2>{c.name}</h2>
          <div className="detail-sub">{c.code} / {componentLabel(c)} / {projectDisplayName(item.project)}</div>
        </div>
        <div className="dashboard-detail-actions">
          <span className={`dot ${state}`} title={healthTitle} />
          <button className={`dashboard-favorite-toggle ${favorite ? 'active' : ''}`} onClick={onToggleFavorite}>
            {favorite ? 'Favorite' : 'Add favorite'}
          </button>
        </div>
      </div>

      <div className="dashboard-detail-grid">
        <section className="detail-section">
          <h3>Startup Monitor</h3>
          <dl className="detail-kv">
            <dt>Health</dt><dd>{healthLabel(c)}</dd>
            <dt>Checked</dt><dd>{fmtTime(c.health_checked_at)}</dd>
            <dt>Last seen</dt><dd>{fmtTime(c.last_seen_at)}</dd>
            <dt>Runtime</dt><dd>{c.runtime ?? '-'}</dd>
            <dt>Startable</dt><dd>{launch ? String(launch.startable) : '-'}</dd>
            <dt>Launch set</dt><dd>{launch ? String(launch.selected) : '-'}</dd>
            <dt>Autostart</dt><dd>{c.autostart == null ? '-' : String(c.autostart)}</dd>
            <dt>Start script</dt><dd>{c.start_script ?? '-'}</dd>
          </dl>
        </section>

        <section className="detail-section">
          <h3>Resource Use</h3>
          <dl className="detail-kv">
            <dt>CPU</dt><dd>{formatCpu(mem?.cpu_pct ?? null)}</dd>
            <dt>Memory</dt><dd>{formatBytes(mem?.rss_bytes ?? null)}</dd>
            <dt>PID</dt><dd>{mem?.pid ?? '-'}</dd>
            <dt>Source</dt><dd>{mem?.primary_source ?? '-'}</dd>
            <dt>24h downtime</dt><dd>{fmtDuration(c.downtime_24h?.downtime_ms ?? 0)}</dd>
            <dt>Current down</dt><dd>{fmtDuration(c.downtime_24h?.current_down_ms ?? 0)}</dd>
            <dt>Incidents</dt><dd>{c.downtime_24h?.incidents ?? '-'}</dd>
          </dl>
        </section>

        <section className="detail-section">
          <h3>Ports</h3>
          <div className="dashboard-port-list">
            {managedPorts(c).length === 0 && <span className="muted">No managed ports.</span>}
            {managedPorts(c).map((p) => {
              const status = portStatusFor(p, portStatuses);
              return (
                <div key={`${p.role}:${p.port}`} className={`dashboard-port-row ${status?.conflict ? 'bad' : ''}`}>
                  <span>{p.role}</span>
                  <code>{p.port}</code>
                  <span>{status?.listening ? 'listening' : 'not listening'}</span>
                  {status?.conflict && <strong>conflict</strong>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="detail-section">
          <h3>Metric Errors</h3>
          {functionMetricPort(c) == null && <div className="metric-empty">No metrics port configured.</div>}
          {functionMetricPort(c) != null && !METRIC_POLL_STATES.has(state) && (
            <div className="metric-empty">Metrics are not polled for this health state.</div>
          )}
          {metric?.requestError && <div className="metric-error">{metric.requestError}</div>}
          {metric && !metric.requestError && (
            <>
              <div className="function-metrics-summary">
                <span className="metric-pill">calls <strong>{metric.calls ?? '-'}</strong></span>
                <span className={`metric-pill ${(metric.errors ?? 0) > 0 ? 'bad' : ''}`}>errors <strong>{metric.errors ?? '-'}</strong></span>
                <span className="metric-pill">checked <strong>{new Date(metric.checkedAt).toLocaleTimeString()}</strong></span>
              </div>
              {metricRows.length === 0 ? (
                <div className="metric-empty">No function metric errors.</div>
              ) : (
                <div className="dashboard-metric-error-list">
                  {metricRows.map((row) => (
                    <div key={row.key} className="dashboard-metric-error-row">
                      <span className="metric-kind">{row.kind}</span>
                      <span className="metric-target">{row.target}</span>
                      <strong>{row.errors}</strong>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section className="detail-section">
          <h3>Open Errors</h3>
          {errors.length === 0 && <div className="metric-empty">No open service errors.</div>}
          {errors.length > 0 && (
            <div className="dashboard-open-error-list">
              {errors.slice(0, 8).map((t) => (
                <div key={t.id} className="dashboard-open-error-row">
                  <span className={`severity ${t.severity}`}>{t.severity}</span>
                  <span>{t.summary}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

async function loadMetricStatuses(projects: Project[]): Promise<MetricStatus[]> {
  const candidates = metricCandidates(projects).filter((c) => METRIC_POLL_STATES.has(componentDisplayState(c)));
  return Promise.all(candidates.map(async (c) => {
    try {
      const data = await fetchFunctionMetrics(c.code, { limit: 12, sort: 'lastAt' });
      return {
        code: c.code,
        checkedAt: Date.now(),
        calls: data.snapshot.totals.calls,
        errors: data.snapshot.totals.errors,
        sourceUrl: data.source_url,
        requestError: null,
        rows: data.snapshot.rows,
      };
    } catch (e: unknown) {
      return {
        code: c.code,
        checkedAt: Date.now(),
        calls: null,
        errors: null,
        sourceUrl: null,
        requestError: (e as Error).message,
        rows: [],
      };
    }
  }));
}

function flattenServices(projects: Project[]): DashboardService[] {
  return projects
    .flatMap((project) => project.components.map((component) => ({ project, component })))
    .sort((a, b) => {
      const attention = Number(serviceNeedsAttention(b.component)) - Number(serviceNeedsAttention(a.component));
      if (attention !== 0) return attention;
      return a.component.code.localeCompare(b.component.code);
    });
}

function shouldShowOnDashboard(c: Component, favorites: Set<string>): boolean {
  return c.autostart === true || RUNNING_STATES.has(componentDisplayState(c)) || favorites.has(c.code);
}

function metricCandidates(projects: Project[]): Component[] {
  const byCode = new Map<string, Component>();
  for (const c of projects.flatMap((p) => p.components)) {
    if (c.disabled || functionMetricPort(c) == null || byCode.has(c.code)) continue;
    byCode.set(c.code, c);
  }
  return [...byCode.values()];
}

function serviceNeedsAttention(c: Component, metric?: MetricStatus, errors?: ErrorTask[]): boolean {
  const state = componentDisplayState(c);
  return state === 'stale'
    || c.health_ok === false
    || ['stopped', 'crashed', 'exited'].includes(state)
    || Boolean(metric?.requestError)
    || (metric?.errors ?? 0) > 0
    || (errors?.length ?? 0) > 0;
}

function buildSummary(
  services: DashboardService[],
  metrics: Map<string, MetricStatus>,
  memByCode: Map<string, MemoryCard>,
  errors: ErrorTask[],
) {
  let cpuPct = 0;
  let hasCpu = false;
  let rssBytes = 0;
  let downtimeMs = 0;
  let currentDownMs = 0;
  for (const { component } of services) {
    const mem = memByCode.get(component.code);
    if (mem?.cpu_pct != null) {
      cpuPct += mem.cpu_pct;
      hasCpu = true;
    }
    if (mem?.rss_bytes != null) rssBytes += mem.rss_bytes;
    downtimeMs += component.downtime_24h?.downtime_ms ?? 0;
    currentDownMs += component.downtime_24h?.current_down_ms ?? 0;
  }
  const visibleCodes = new Set(services.map((s) => s.component.code));
  let metricErrors = 0;
  for (const [code, metric] of metrics.entries()) {
    if (!visibleCodes.has(code)) continue;
    if (metric.requestError || (metric.errors ?? 0) > 0) metricErrors += 1;
  }
  const openErrors = errors.filter((e) => e.service_code && visibleCodes.has(e.service_code)).length;
  return {
    cpuPct: hasCpu ? cpuPct : null,
    rssBytes,
    downtimeMs,
    currentDownMs,
    metricErrors,
    openErrors,
  };
}

function launchServiceMap(plan: LaunchPlan | null): Map<string, PlanService> {
  const map = new Map<string, PlanService>();
  for (const p of plan?.projects ?? []) {
    for (const s of p.services) map.set(s.code, s);
  }
  return map;
}

function groupErrorTasks(tasks: ErrorTask[]): Map<string, ErrorTask[]> {
  const map = new Map<string, ErrorTask[]>();
  for (const task of tasks) {
    if (!task.service_code) continue;
    const list = map.get(task.service_code) ?? [];
    list.push(task);
    map.set(task.service_code, list);
  }
  return map;
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

function componentDisplayState(c: Component): string {
  const hasHealth = c.health_ok === true || c.health_ok === false;
  const age = typeof c.health_checked_at === 'number' ? Date.now() - c.health_checked_at : null;
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
  if (typeof c.health_checked_at === 'number') parts.push(`checked: ${new Date(c.health_checked_at).toLocaleString()}`);
  return parts.join(' / ');
}

function healthLabel(c: Component): string {
  if (c.health_ok === true) return 'OK';
  if (c.health_ok === false) return c.health_reason ? `Failed: ${c.health_reason}` : 'Failed';
  return 'Unknown';
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

function functionMetricPort(c: Component): number | null {
  if (typeof c.backend_port === 'number') return c.backend_port;
  const rolePort = c.ports?.find((p) => ['backend', 'api', 'service'].includes(p.role))?.port;
  if (typeof rolePort === 'number') return rolePort;
  if (typeof c.port === 'number') return c.port;
  if (typeof c.frontend_port === 'number') return c.frontend_port;
  const firstPort = c.ports?.[0]?.port;
  return typeof firstPort === 'number' ? firstPort : null;
}

function primaryPortLabel(c: Component, statuses: ServicePortStatus[]): string {
  const primary = c.port ?? managedPorts(c)[0]?.port ?? statuses[0]?.port;
  return primary ? `:${primary}` : '-';
}

function portStatusFor(
  port: { role: string; port: number },
  statuses: ServicePortStatus[],
): ServicePortStatus | undefined {
  return statuses.find((s) => s.port === port.port && s.role === port.role)
    ?? statuses.find((s) => s.port === port.port);
}

function metricBadgeTone(c: Component, metric: MetricStatus | undefined): string {
  const state = componentDisplayState(c);
  if (functionMetricPort(c) == null || !METRIC_POLL_STATES.has(state)) return 'muted';
  if (!metric) return 'loading';
  if (metric.requestError || (metric.errors ?? 0) > 0) return 'bad';
  return 'ok';
}

function metricBadgeLabel(c: Component, metric: MetricStatus | undefined): string {
  const state = componentDisplayState(c);
  if (functionMetricPort(c) == null) return 'no metrics';
  if (!METRIC_POLL_STATES.has(state)) return 'idle';
  if (!metric) return 'checking';
  if (metric.requestError) return 'metrics error';
  if ((metric.errors ?? 0) > 0) return `${metric.errors} metric errors`;
  return 'metrics ok';
}

function projectDisplayName(project: Project): string {
  const explicit = project.project_name && project.project_name !== project.project_code ? project.project_name : null;
  const named = project.components.find((c) => c.name && c.name.toLowerCase() !== c.code.toLowerCase())?.name;
  return explicit ?? named ?? project.project_code;
}

function componentLabel(c: Component): string {
  return (c.component ?? 'service').replace(/^\w/, (s) => s.toUpperCase());
}

function resourceBadge(mem: MemoryCard | undefined): string {
  const cpu = formatCpu(mem?.cpu_pct ?? null);
  const rss = formatBytes(mem?.rss_bytes ?? null);
  if (cpu === '-' && rss === '-') return '-';
  return `${cpu} / ${rss}`;
}

function formatCpu(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : `${value.toFixed(1)}%`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / 1024 ** 2;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function fmtDuration(ms: number | null | undefined): string {
  const sec = Math.max(0, Math.floor((ms ?? 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

function fmtTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Date(value).toLocaleString();
}

function loadFavorites(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(codes: Set<string>): void {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...codes].sort()));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}
