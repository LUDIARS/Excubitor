import { useEffect, useRef, useState } from 'react';
import { fetchProjects, controlService, type Project, type ControlAction } from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';

export default function Catalog() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [busyCodes, setBusyCodes] = useState<Set<string>>(() => new Set());
  const busyRef = useRef<Set<string>>(new Set());
  const [controlError, setControlError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    try {
      setProjects(await fetchProjects());
      setFetchError(null);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  useEffect(() => {
    void reload().catch(() => undefined);
    const id = setInterval(() => void reload().catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, []);

  const onControl = async (code: string, action: ControlAction): Promise<void> => {
    if (busyRef.current.has(code)) return;
    busyRef.current.add(code);
    setBusyCodes((current) => new Set(current).add(code));
    setControlError(null);
    try {
      await controlService(code, action);
      await reload().catch(() => undefined);
    } catch (error: unknown) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current.delete(code);
      setBusyCodes((current) => {
        const next = new Set(current);
        next.delete(code);
        return next;
      });
    }
  };

  return (
    <div>
      <div className="control-proxy-note">
        <strong>Local tool proxy</strong>
        <span>Lifecycle actions are executed by the persistent local supervisor through <code>excubitorctl</code>.</span>
      </div>
      {fetchError && <div className="control-error" role="alert">Catalog refresh failed: {fetchError}</div>}
      {controlError && <div className="control-error" role="alert">{controlError}</div>}
      {projects.map((project) => (
        <div key={project.project_code}>
          <h2>{project.project_name}</h2>
          {project.components.map((component) => (
            <div key={component.code}>
              {component.code} {component.state}{' '}
              <button
                disabled={busyCodes.has(component.code)}
                onClick={() => void onControl(component.code, 'restart')}
              >
                Restart via tool
              </button>
              <button onClick={() => setOpenCode(component.code)}>Logs</button>
            </div>
          ))}
        </div>
      ))}
      {openCode && <LogsDrawer code={openCode} onClose={() => setOpenCode(null)} />}
    </div>
  );
}
