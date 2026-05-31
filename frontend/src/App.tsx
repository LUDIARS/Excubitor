import { useEffect, useState } from 'react';
import Monitor from './pages/Monitor';
import Catalog from './pages/Catalog';
import Errors from './pages/Errors';

type Tab = 'monitor' | 'catalog' | 'errors';

const TABS: { id: Tab; label: string }[] = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'errors', label: 'Errors' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '') as Tab;
    return (['monitor', 'catalog', 'errors'] as Tab[]).includes(h) ? h : 'monitor';
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
        {tab === 'monitor' && <Monitor />}
        {tab === 'catalog' && <Catalog />}
        {tab === 'errors' && <Errors />}
      </main>
    </div>
  );
}
