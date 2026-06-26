import { useEffect, useState } from 'react';
import type { Project, Component, ControlAction, CommitInfo, PortReport, ServicePortStatus } from '../lib/api';
import { fetchProjects, controlService, fetchCommits, fetchPorts, setCorpusPref } from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';

export default function Monitor() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logsOpenFor, setLogsOpenFor] = useState<string | null>(null);
  const [ports, setPorts] = useState<PortReport | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const [list, portReport] = await Promise.all([fetchProjects(), fetchPorts().catch(() => null)]);
        if (!stopped) {
          setProjects(list);
          setPorts(portReport);
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

  const portByCode = new Map<string, ServicePortStatus>((ports?.services ?? []).map((s) => [s.code, s]));

  return (
    <>
      {error && <div className="error-banner">エラー: {error}</div>}
      {ports?.hasConflict && (
        <div className="error-banner">
          ⚠ ポート衝突: {ports.services.filter((s) => s.conflict).map((s) => `${s.code}(:${s.port})`).join(', ')}
          {' '}— 停止中なのに別プロセスが占有しています
        </div>
      )}
      {ports && ports.declaredConflicts.length > 0 && (
        <div className="warn-banner">
          カタログ重複宣言: {ports.declaredConflicts.map((d) => `:${d.port}→${d.codes.join('/')}`).join(', ')}
        </div>
      )}
      {projects === null && <div className="empty-state">読み込み中…</div>}
      {projects !== null && projects.length === 0 && (
        <div className="empty-state">登録サービスがありません。 catalog/services.yaml を確認してください。</div>
      )}
      {projects !== null && projects.length > 0 && (
        <div className="projects">
          {projects.map((p) => (
            <ProjectCard key={p.project_code} project={p} portByCode={portByCode} onShowLogs={setLogsOpenFor} />
          ))}
        </div>
      )}
      {logsOpenFor && <LogsDrawer code={logsOpenFor} onClose={() => setLogsOpenFor(null)} />}
    </>
  );
}

function ProjectCard({
  project,
  portByCode,
  onShowLogs,
}: {
  project: Project;
  portByCode: Map<string, ServicePortStatus>;
  onShowLogs: (code: string) => void;
}) {
  return (
    <article className="project-card">
      <h2>{project.project_code}</h2>
      <div className="components">
        {project.components.map((c) => (
          <ComponentCard key={c.code} c={c} port={portByCode.get(c.code)} onShowLogs={onShowLogs} />
        ))}
      </div>
    </article>
  );
}

function ComponentCard({
  c,
  port,
  onShowLogs,
}: {
  c: Component;
  port: ServicePortStatus | undefined;
  onShowLogs: (code: string) => void;
}) {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [showCommits, setShowCommits] = useState(false);
  const [usesCorpus, setUsesCorpus] = useState<boolean>(c.uses_corpus ?? false);

  const isProcess = c.runtime === 'node' || c.runtime === 'dev-process-md' || c.runtime === 'app';
  const isDocker = c.runtime === 'docker-compose' || c.runtime === 'docker';

  useEffect(() => {
    setUsesCorpus(c.uses_corpus ?? false);
  }, [c.uses_corpus]);

  const loadCommits = async () => {
    setShowCommits((v) => !v);
    if (commits === null) {
      try {
        setCommits(await fetchCommits(c.code, 5));
      } catch {
        setCommits([]);
      }
    }
  };

  const act = async (action: ControlAction) => {
    const ok = window.confirm(`${c.code} に対して ${action} を実行しますか?`);
    if (!ok) return;
    const result = await controlService(c.code, action);
    if (!result.ok) alert(`${action} 失敗: ${result.stderr || result.stdout}`);
  };

  const toggleCorpus = async () => {
    const next = !usesCorpus;
    setUsesCorpus(next);
    try {
      await setCorpusPref(c.code, next);
    } catch {
      setUsesCorpus(!next); // revert
    }
  };

  const portConflict = port?.conflict;

  return (
    <div className={`component-card ${c.state}`}>
      <div className="cc-head">
        <span className={`dot ${c.state}`} title={c.state} />
        <span className="cc-name">{c.component ?? c.code}</span>
        <span className="cc-code">{c.code}</span>
        <span className="cc-spacer" />
        <span className={`cc-port ${portConflict ? 'conflict' : ''}`} title={port ? portStatusText(port) : ''}>
          {c.port ? `:${c.port}` : '—'}
        </span>
      </div>

      <div className="cc-meta">
        <span className={`state-badge ${c.state}`}>{c.state}</span>
        {c.runtime && <span className="tag">{c.runtime}</span>}
        {c.tier && <span className="tag tier">{c.tier}</span>}
        {c.package_version && <span className="tag">v{c.package_version}</span>}
        {c.monitor_only && <span className="tag">monitor-only</span>}
        {c.start_script && <span className="tag bat" title={c.start_script}>bat</span>}
        {c.has_vestigium && <span className="tag vg" title={c.log_path ?? 'Vestigium JSONL'}>Vg</span>}
        {portConflict && <span className="tag conflict" title={portStatusText(port!)}>port 衝突</span>}
      </div>

      {c.git.branch && (
        <div className="cc-git">
          <code>{c.git.branch}</code>
          {c.git.hash && <> @ <code>{c.git.hash.slice(0, 8)}</code></>}
          {c.git.dirty && <span className="dirty-flag"> (dirty)</span>}
          {c.last_seen_at && <span className="cc-seen"> · 最終確認 {fmtTime(c.last_seen_at)}</span>}
        </div>
      )}

      <div className="cc-actions">
        {(isProcess || isDocker) && (
          <>
            {c.state !== 'running' && <button onClick={() => void act('start')} title="start">▶ 起動</button>}
            {c.state === 'running' && <button onClick={() => void act('stop')} title="stop">■ 停止</button>}
            <button onClick={() => void act('restart')} title="restart">↻ 再起動</button>
            <button onClick={() => onShowLogs(c.code)} title="logs">≡ ログ</button>
          </>
        )}
        <button className={`corpus-toggle ${usesCorpus ? 'on' : ''}`} onClick={() => void toggleCorpus()} title="Corpus 連携">
          Corpus {usesCorpus ? 'ON' : 'OFF'}
        </button>
        <button className="link-btn" onClick={() => void loadCommits()}>
          {showCommits ? '▲ 更新履歴' : '▼ 更新履歴'}
        </button>
      </div>

      {showCommits && (
        <div className="cc-commits">
          {commits === null && <div className="muted">読み込み中…</div>}
          {commits !== null && commits.length === 0 && <div className="muted">コミット履歴なし</div>}
          {commits?.map((cm) => (
            <div className="commit-row" key={cm.hash}>
              <code className="commit-hash">{cm.hash}</code>
              <span className="commit-subject">{cm.subject}</span>
              <span className="commit-rel">{cm.relative}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function portStatusText(p: ServicePortStatus): string {
  if (!p.listening) return `:${p.port} 空き`;
  const who = p.processNames.length > 0 ? p.processNames.join(',') : `pid ${p.pids.join(',')}`;
  return `:${p.port} ${p.conflict ? '衝突' : '使用中'} (${who})`;
}

function fmtTime(ms: string | number): string {
  const n = typeof ms === 'string' ? Number(ms) : ms;
  if (!Number.isFinite(n)) return '';
  return new Date(n).toLocaleTimeString('ja-JP');
}
