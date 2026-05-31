import { useEffect, useState } from 'react';
import { fetchProjects, controlService, type Project, type ControlAction } from '../lib/api';
import LogsDrawer from '../components/LogsDrawer';

export default function Catalog() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [openCode, setOpenCode] = useState<string | null>(null);

  useEffect(() => {
    const tick = async () => setProjects(await fetchProjects());
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => clearInterval(id);
  }, []);

  const onControl = async (code: string, action: ControlAction) => {
    await controlService(code, action);
  };

  return <div>{projects.map((p) => <div key={p.project_code}>{p.project_name} {p.components.map((c) => <div key={c.code}>{c.code} {c.state} <button onClick={() => void onControl(c.code, 'restart')}>restart</button><button onClick={() => setOpenCode(c.code)}>logs</button></div>)}</div>)}{openCode && <LogsDrawer code={openCode} onClose={() => setOpenCode(null)} />}</div>;
}
