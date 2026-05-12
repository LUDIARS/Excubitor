import { useEffect, useState } from 'react';
import Dashboard from './pages/Dashboard';
import Errors from './pages/Errors';
import Infisical from './pages/Infisical';

type Tab = 'dashboard' | 'errors' | 'infisical';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Services' },
  { id: 'errors', label: 'Errors' },
  { id: 'infisical', label: 'Infisical' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '') as Tab;
    return (['dashboard', 'errors', 'infisical'] as Tab[]).includes(h) ? h : 'dashboard';
  });

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Excubitor</h1>
        <span className="badge">v0.1</span>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="container">
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'errors' && <Errors />}
        {tab === 'infisical' && <Infisical />}
      </main>
    </div>
  );
}
