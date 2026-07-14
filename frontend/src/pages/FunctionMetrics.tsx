import { useEffect, useMemo, useState } from 'react';
import FunctionMetricsPanel from '../components/FunctionMetricsPanel';
import { fetchProjects, type Component, type Project } from '../lib/api';

export default function FunctionMetrics() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedCode, setSelectedCode] = useState('concordia');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const list = await fetchProjects();
        if (!stopped) {
          setProjects(list);
          setError(null);
        }
      } catch (e: unknown) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 10000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  const candidates = useMemo(() => metricCandidates(projects ?? []), [projects]);

  useEffect(() => {
    if (candidates.length === 0) return;
    if (candidates.some((c) => c.code === selectedCode)) return;
    setSelectedCode(candidates.find((c) => c.code === 'concordia')?.code ?? candidates[0]!.code);
  }, [candidates, selectedCode]);

  return (
    <div className="function-metrics-page">
      {error && <div className="error-banner">Error: {error}</div>}
      {projects === null && !error && <div className="empty-state">Loading...</div>}
      {projects !== null && candidates.length === 0 && (
        <div className="empty-state">No services with a metrics port are registered.</div>
      )}
      {candidates.length > 0 && (
        <FunctionMetricsPanel
          candidates={candidates}
          selectedCode={selectedCode}
          onSelectCode={setSelectedCode}
        />
      )}
    </div>
  );
}

function metricCandidates(projects: Project[]): Component[] {
  const byCode = new Map<string, Component>();
  for (const c of projects.flatMap((p) => p.components)) {
    if (c.disabled || functionMetricPort(c) == null || byCode.has(c.code)) continue;
    byCode.set(c.code, c);
  }
  return [...byCode.values()].sort((a, b) => {
    if (a.code === 'concordia') return -1;
    if (b.code === 'concordia') return 1;
    return a.code.localeCompare(b.code);
  });
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
