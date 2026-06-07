import { useEffect, useState } from 'react';
import type { Project, Component, ControlAction } from '../lib/api';
import { fetchProjects, controlService } from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';

export default function Monitor() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logsOpenFor, setLogsOpenFor] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
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
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      {error && <div className="error-banner">エラー: {error}</div>}
      {projects === null && <div className="empty-state">読み込み中…</div>}
      {projects !== null && projects.length === 0 && (
        <div className="empty-state">登録サービスがありません。 catalog/services.yaml を確認してください。</div>
      )}
      {projects !== null && projects.length > 0 && (
        <div className="projects">
          {projects.map((p) => (
            <ProjectCard key={p.project_code} project={p} onShowLogs={setLogsOpenFor} />
          ))}
        </div>
      )}
      {logsOpenFor && <LogsDrawer code={logsOpenFor} onClose={() => setLogsOpenFor(null)} />}
    </>
  );
}

function ProjectCard({ project, onShowLogs }: { project: Project; onShowLogs: (code: string) => void }) {
  const hosts = Array.from(
    new Set(project.components.map((c) => c.host?.hostname).filter(Boolean)),
  ) as string[];
  const repGit = project.components.find((c) => c.git.hash)?.git;

  return (
    <article className="project-card">
      <h2>{project.project_code}</h2>
      <div className="pc-meta">
        {hosts.length > 0 && <span>host: {hosts.join(', ')}</span>}
        {repGit?.branch && (
          <>
            {' '}· <code>{repGit.branch}</code> @ <code>{repGit.hash}</code>
            {repGit.dirty && <span className="dirty-flag"> (dirty)</span>}
          </>
        )}
      </div>
      <div className="components">
        {project.components.map((c) => (
          <ComponentRow key={c.code} c={c} onShowLogs={onShowLogs} />
        ))}
      </div>
    </article>
  );
}

function ComponentRow({ c, onShowLogs }: { c: Component; onShowLogs: (code: string) => void }) {
  const cls = `dot ${c.state}`;
  const isProcess = c.runtime === 'node' || c.runtime === 'dev-process-md';
  const isDocker = c.runtime === 'docker-compose' || c.runtime === 'docker';

  const act = async (action: ControlAction) => {
    const ok = window.confirm(`${c.code} に対して ${action} を実行しますか?`);
    if (!ok) return;
    const result = await controlService(c.code, action);
    if (!result.ok) alert(`${action} 失敗: ${result.stderr || result.stdout}`);
  };

  return (
    <div className="component-row">
      <span className={cls} title={c.state} />
      <div>
        <div className="comp-name">
          {c.component ?? c.code}
          {c.component && c.component !== c.code && <span className="role">{c.runtime ?? ''}</span>}
        </div>
        <div className="comp-meta">
          {c.state}
          {c.package_version && <> · v{c.package_version}</>}
          {c.monitor_only && <> · monitor-only</>}
          {c.has_vestigium && <span className="vg-badge" title={c.log_path ?? 'Vestigium JSONL'}>Vg</span>}
        </div>
      </div>
      <div className="comp-actions">
        <span className="comp-port">{c.port ? `:${c.port}` : '—'}</span>
        {(isProcess || isDocker) && (
          <div className="comp-buttons">
            {c.state !== 'running' && (
              <button onClick={() => void act('start')} title="start">▶</button>
            )}
            {c.state === 'running' && (
              <button onClick={() => void act('stop')} title="stop">■</button>
            )}
            <button onClick={() => void act('restart')} title="restart">↻</button>
            <button onClick={() => onShowLogs(c.code)} title="logs">≡</button>
          </div>
        )}
      </div>
    </div>
  );
}
