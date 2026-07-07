import { useEffect, useState } from 'react';
import Monitor from './pages/Monitor';
import Memory from './pages/Memory';
import Logs from './pages/Logs';
import Catalog from './pages/Catalog';
import Errors from './pages/Errors';
import Config from './pages/Config';
import Federation from './pages/Federation';
import { fetchSystem } from './lib/api';
import type { SystemInfo } from './lib/api';
import { config } from '../config';

type Tab = 'monitor' | 'memory' | 'logs' | 'federation' | 'catalog' | 'errors' | 'config';

const TAB_IDS: Tab[] = ['monitor', 'memory', 'logs', 'federation', 'catalog', 'errors', 'config'];

const TABS: { id: Tab; label: string }[] = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'memory', label: 'Memory' },
  { id: 'logs', label: 'Logs' },
  { id: 'federation', label: 'Federation' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'errors', label: 'Errors' },
  { id: 'config', label: 'Config' },
];

const frontendUrls = (config.allowedHosts as readonly string[])
  .filter((host) => host !== 'localhost' && host !== '127.0.0.1')
  .map((host) => `https://${host}`);

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '') as Tab;
    return TAB_IDS.includes(h) ? h : 'monitor';
  });

  const [safeMode, setSafeMode] = useState(false);
  const [serviceMode, setServiceMode] = useState(false);
  const [buildVersion, setBuildVersion] = useState<SystemInfo['build_version']>(null);

  useEffect(() => {
    void fetchSystem()
      .then((s) => {
        setSafeMode(s.safe_mode);
        setServiceMode(!!s.service_mode);
        setBuildVersion(s.build_version ?? null);
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
        <span
          className="badge"
          title={buildVersion?.git_hash ? `patch: ${buildVersion.patch_source}, git: ${buildVersion.git_hash}` : undefined}
        >
          v{buildVersion?.version ?? '1.4'}
        </span>
        {safeMode && (
          <span className="badge badge-safe" title="SafeMode: 何も自動起動していません (手動で起動してください)">
            SAFE MODE
          </span>
        )}
        {serviceMode && <span className="badge">SERVICE</span>}
        {frontendUrls.length > 0 && (
          <div className="frontend-links">
            {frontendUrls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a>
            ))}
          </div>
        )}
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="container">
        {tab === 'monitor' && <Monitor />}
        {tab === 'memory' && <Memory />}
        {tab === 'logs' && <Logs />}
        {tab === 'federation' && <Federation />}
        {tab === 'catalog' && <Catalog />}
        {tab === 'errors' && <Errors />}
        {tab === 'config' && <Config />}
      </main>
    </div>
  );
}
