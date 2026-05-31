import { useEffect, useState } from 'react';
import { fetchErrorTasks, type ErrorTask } from '../lib/api';

export default function Errors() {
  const [tasks, setTasks] = useState<ErrorTask[]>([]);
  useEffect(() => {
    const tick = async () => setTasks(await fetchErrorTasks('open'));
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => clearInterval(id);
  }, []);
  return <div>{tasks.map((t) => <div key={t.id}>{t.service_code}: {t.summary}</div>)}</div>;
}
