import { useEffect, useState } from 'react';
import Launch from './pages/Launch';
import Launcher from './pages/Launcher';
import Monitor from './pages/Monitor';
import Catalog from './pages/Catalog';
import Errors from './pages/Errors';
import Config from './pages/Config';
import { fetchLaunchPlan } from './lib/api';

type Tab = 'launch' | 'launcher' | 'monitor' | 'catalog' | 'errors' | 'config';

const TAB_IDS: Tab[] = ['launch', 'launcher', 'monitor', 'catalog', 'errors', 'config'];

const TABS: { id: Tab; label: string }[] = [
  { id: 'launch', label: 'Launch' },
  { id: 'launcher', label: 'Launcher' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'errors', label: 'Errors' },
  { id: 'config', label: 'Config' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '') as Tab;
    return TAB_IDS.includes(h) ? h : 'launch';
  });

  // 初回 (未設定) なら強制的にウィザード (Launch) を出す。
  useEffect(() => {
    void fetchLaunchPlan()
      .then((p) => {
        if (!p.profile.configured) setTab('launch');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Excubitor</h1>
        <span className="badge">v0.2</span>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="container">
        {tab === 'launch' && <Launch />}
        {tab === 'launcher' && <Launcher />}
        {tab === 'monitor' && <Monitor />}
        {tab === 'catalog' && <Catalog />}
        {tab === 'errors' && <Errors />}
        {tab === 'config' && <Config />}
      </main>
    </div>
  );
}
