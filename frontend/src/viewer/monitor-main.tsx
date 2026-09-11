import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Monitor from '../pages/Monitor';
import type { Project } from '../lib/api';
import '../styles.css';

/** Reads only the DMZ display snapshot. @implements SPEC-VIEWER-MONITOR */
function MonitorView() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = async (): Promise<void> => {
      const request = new AbortController();
      const cancel = (): void => request.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      const deadline = setTimeout(cancel, 15_000);
      try {
        const response = await fetch('/viewer/apps/excubitor/snapshot', { signal: request.signal });
        if (!response.ok) throw new Error('Monitorの表示情報を取得できません。');
        const result = await response.json() as { projects: Project[] };
        if (!controller.signal.aborted) { setProjects(result.projects); setError(''); }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setProjects(null);
          setError(cause instanceof Error ? cause.message : 'Monitorの取得に失敗しました。');
        }
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener('abort', cancel);
        if (!controller.signal.aborted) timer = setTimeout(() => void reload(), 10_000);
      }
    };
    void reload();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return <div className="app">
    <header className="app-header"><h1>Excubitor</h1><span className="badge">Monitor · 閲覧専用</span></header>
    <main className="container">
      {error ? <div className="error-banner" role="alert">{error}</div>
        : projects ? <Monitor snapshot={projects} /> : <div className="empty-state">Loading...</div>}
    </main>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(<MonitorView />);
