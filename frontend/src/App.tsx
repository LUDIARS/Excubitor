import Overview from './overview/Overview';
import { useEffect, useState } from 'react';
import Dashboard from './pages/Dashboard';
import Monitor from './pages/Monitor';
import FunctionMetrics from './pages/FunctionMetrics';
import Memory from './pages/Memory';
import Logs from './pages/Logs';
import Catalog from './pages/Catalog';
import Errors from './pages/Errors';
import Config from './pages/Config';
import Federation from './pages/Federation';
import { fetchSystem } from './lib/api';
import type { SystemInfo } from './lib/api';
import { config } from '../config';

type Tab = 'overview' | 'dashboard' | 'monitor' | 'function-metrics' | 'memory' | 'logs' | 'federation' | 'catalog' | 'errors' | 'config';

const TAB_IDS: Tab[] = ['overview', 'dashboard', 'monitor', 'function-metrics', 'memory', 'logs', 'federation', 'catalog', 'errors', 'config'];

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'サービス' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Config' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'errors', label: 'Errors' },
  { id: 'memory', label: 'Memory' },
  { id: 'function-metrics', label: 'Function Metrics' },
  { id: 'federation', label: 'Federation' },
];

const frontendUrls = (config.allowedHosts as readonly string[])
  .filter((host) => host !== 'localhost' && host !== '127.0.0.1')
  .map((host) => `https://${host}`);

/** @implements SPEC-SERVICE-RUNTIME-VERSION */
export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '') as Tab;
    return h.startsWith('overview') ? 'overview' : TAB_IDS.includes(h) ? h : 'overview';
  });

  const [route, setRoute] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const changed = () => {
      const hash = window.location.hash.slice(1);
      setRoute(hash);
      const id = hash.split('/')[0] as Tab;
      setTab(TAB_IDS.includes(id) ? id : 'overview');
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const [safeMode, setSafeMode] = useState(false);
  const [serviceMode, setServiceMode] = useState(false);
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const [buildVersion, setBuildVersion] = useState<SystemInfo['build_version']>(null);

  // @implements SPEC-SERVICE-RUNTIME-VERSION
  useEffect(() => {
    void fetchSystem()
      .then((s) => {
        setSafeMode(s.safe_mode);
        setServiceMode(!!s.service_mode);
        setRuntimeVersion(s.runtime_version ?? null);
        setBuildVersion(s.build_version ?? null);
      })
      .catch(() => {
        // Header metadata is best-effort; the UI remains usable with the
        // explicit unavailable fallback when the backend is still starting.
      });
  }, []);

  useEffect(() => {
    if (window.location.hash.slice(1).split('/')[0] !== tab) window.location.hash = tab;
  }, [tab]);

  return (
    <div className={tab === 'overview' ? 'app ex-shell' : 'app'}>
      <header className="app-header">
        <h1>Excubitor</h1>
        <span
          className="badge"
          title={buildVersion?.git_hash ? `patch: ${buildVersion.patch_source}, git: ${buildVersion.git_hash}` : undefined}
        >
          v{runtimeVersion ?? buildVersion?.version ?? 'unavailable'}
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
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); window.location.hash = t.id; }}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="container">
        {tab === 'overview' && <Overview route={route} />}
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'monitor' && <Monitor />}
        {tab === 'function-metrics' && <FunctionMetrics />}
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
