import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchErrorTasks,
  fetchFunctionMetrics,
  fetchLaunchPlan,
  fetchPorts,
  fetchProjects,
  type Component,
  type ErrorTask,
  type FunctionMetricAggregate,
  type LaunchPlan,
  type PlanService,
  type PortReport,
  type Project,
  type ServicePortStatus,
} from '../lib/api';

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
  const [errorTasks, setErrorTasks] = useState<ErrorTask[]>([]);
  const [metricsByCode, setMetricsByCode] = useState<Map<string, MetricStatus>>(new Map());
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const metricRun = useRef(0);

  const reloadCore = async () => {
    setRefreshing(true);
    try {
      const [projectList, portReport, launchPlan, tasks] = await Promise.all([
        fetchProjects(),
        fetchPorts().catch(() => null),
        fetchLaunchPlan().catch(() => null),
        fetchErrorTasks('open').catch(() => []),
      ]);
      setProjects(projectList);
      setPorts(portReport);
      setPlan(launchPlan);
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

  const services = useMemo(() => flattenServices(projects ?? []), [projects]);
  const portsByCode = useMemo(() => groupPortStatuses(ports?.services ?? []), [ports]);
  const launchByCode = useMemo(() => launchServiceMap(plan), [plan]);
  const errorsByCode = useMemo(() => groupErrorTasks(errorTasks), [errorTasks]);

  useEffect(() => {
    if (services.length === 0) return;
    if (selectedCode && services.some((s) => s.component.code === selectedCode)) return;
    const needsAttention = services.find((s) => serviceNeedsAttention(s.component, metricsByCode.get(s.component.code), errorsByCode.get(s.component.code)));
    setSelectedCode((needsAttention ?? services[0]!).component.code);
  }, [services, selectedCode, metricsByCode, errorsByCode]);

  const selected = services.find((s) => s.component.code === selectedCode) ?? services[0] ?? null;
  const summary = buildSummary(services, metricsByCode, errorTasks);

  return (
    <div className="dashboard-page">
      {error && <div className="error-banner">Error: {error}</div>}

      <div className="dashboard-head">
        <div>
          <h2>Dashboard</h2>
          <div className="dashboard-sub">Service startup monitor and function metric errors.</div>
        </div>
        <button disabled={refreshing} onClick={() => void reloadCore()}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="dashboard-summary">
        <SummaryTile label="Services" value={summary.total} />
        <SummaryTile label="Running" value={summary.running} tone="ok" />
        <SummaryTile label="Down" value={summary.down} tone={summary.down > 0 ? 'bad' : undefined} />
        <SummaryTile label="Stale" value={summary.stale} tone={summary.stale > 0 ? 'warn' : undefined} />
        <SummaryTile label="Metric Errors" value={summary.metricErrors} tone={summary.metricErrors > 0 ? 'bad' : undefined} />
        <SummaryTile label="Open Errors" value={summary.openErrors} tone={summary.openErrors > 0 ? 'bad' : undefined} />
      </div>

      {projects === null && !error && <div className="empty-state">Loading...</div>}
      {projects !== null && services.length === 0 && <div className="empty-state">No services registered.</div>}

      {services.length > 0 && (
        <div className="dashboard-layout">
          <section className="dashboard-service-list">
            <div className="dashboard-list-head">
              <span>Services</span>
              {metricsBusy && <span className="muted">metrics polling</span>}
            </div>
            {services.map((item) => (
              <ServiceListButton
                key={item.component.code}
                item={item}
                selected={item.component.code === selected?.component.code}
                portStatuses={portsByCode.get(item.component.code) ?? []}
                metric={metricsByCode.get(item.component.code)}
                errors={errorsByCode.get(item.component.code) ?? []}
                onSelect={() => setSelectedCode(item.component.code)}
              />
            ))}
          </section>

          <section className="dashboard-detail">
            {selected && (
              <ServiceDashboardDetail
                item={selected}
                launch={launchByCode.get(selected.component.code)}
                portStatuses={portsByCode.get(selected.component.code) ?? []}
                metric={metricsByCode.get(selected.component.code)}
                errors={errorsByCode.get(selected.component.code) ?? []}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }) {
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
  portStatuses,
  metric,
  errors,
  onSelect,
}: {
  item: DashboardService;
  selected: boolean;
  portStatuses: ServicePortStatus[];
  metric: MetricStatus | undefined;
  errors: ErrorTask[];
  onSelect: () => void;
}) {
  const c = item.component;
  const state = componentDisplayState(c);
  const port = primaryPortLabel(c, portStatuses);
  const metricTone = metricBadgeTone(c, metric);
  return (
    <button className={`dashboard-service-button ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className={`dot ${state}`} title={componentHealthTitle(c, state)} />
      <span className="dashboard-service-main">
        <span className="dashboard-service-name">{c.name}</span>
        <span className="dashboard-service-meta">{c.code} / {projectDisplayName(item.project)}</span>
      </span>
      <span className="dashboard-service-side">
        <span className={`state-badge ${state}`}>{state}</span>
        <span className={`dashboard-metric-badge ${metricTone}`}>{metricBadgeLabel(c, metric)}</span>
        {errors.length > 0 && <span className="dashboard-error-count">{errors.length}</span>}
        <span className="cc-port">{port}</span>
      </span>
    </button>
  );
}

function ServiceDashboardDetail({
  item,
  launch,
  portStatuses,
  metric,
  errors,
}: {
  item: DashboardService;
  launch: PlanService | undefined;
  portStatuses: ServicePortStatus[];
  metric: MetricStatus | undefined;
  errors: ErrorTask[];
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
        <span className={`state-badge ${state}`} title={healthTitle}>{state}</span>
      </div>

      <div className="dashboard-detail-grid">
        <section className="detail-section">
          <h3>Startup Monitor</h3>
          <dl className="detail-kv">
            <dt>Health</dt><dd>{healthTitle}</dd>
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
            <div className="metric-empty">Metrics are not polled while the service is {state}.</div>
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

function buildSummary(services: DashboardService[], metrics: Map<string, MetricStatus>, errors: ErrorTask[]) {
  let running = 0;
  let down = 0;
  let stale = 0;
  for (const { component } of services) {
    const state = componentDisplayState(component);
    if (RUNNING_STATES.has(state)) running += 1;
    if (state === 'stale') stale += 1;
    if (component.health_ok === false || ['stopped', 'crashed', 'exited'].includes(state)) down += 1;
  }
  let metricErrors = 0;
  for (const metric of metrics.values()) {
    if (metric.requestError || (metric.errors ?? 0) > 0) metricErrors += 1;
  }
  return {
    total: services.length,
    running,
    down,
    stale,
    metricErrors,
    openErrors: errors.length,
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

function fmtTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Date(value).toLocaleString();
}
