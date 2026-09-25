import { useEffect, useRef, useState } from 'react';
import './viewer.css';

interface ServiceEntry {
  code: string;
  name: string;
  href: string;
  excludedReason: string | null;
  status: 'up' | 'down' | 'unknown';
}

function selectedFromUrl(): string {
  return new URLSearchParams(location.search).get('service') ?? 'villa';
}

export default function Viewer() {
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [selected, setSelected] = useState(selectedFromUrl);
  const [menuOpen, setMenuOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const menuButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/viewer/services', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('サービス一覧を取得できませんでした。');
        const result = await response.json() as { services: ServiceEntry[] };
        setServices(result.services);
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'サービス一覧を取得できませんでした。');
      });
    const pop = (): void => { setSelected(selectedFromUrl()); setLoading(true); };
    window.addEventListener('popstate', pop);
    return () => { controller.abort(); window.removeEventListener('popstate', pop); };
  }, []);

  useEffect(() => { if (menuOpen) searchInput.current?.focus(); }, [menuOpen]);
  const active = services.find((service) => service.code === selected && !service.excludedReason);
  const visible = services.filter((service) => `${service.name} ${service.code}`.toLowerCase().includes(query.toLowerCase()));
  const closeMenu = (): void => { setMenuOpen(false); menuButton.current?.focus(); };
  const select = (service: ServiceEntry): void => {
    const url = new URL(location.href);
    url.searchParams.set('service', service.code);
    history.pushState(null, '', url);
    setSelected(service.code);
    setLoading(true);
    setFrameKey((key) => key + 1);
    closeMenu();
  };

  return <div className="viewer" onKeyDown={(event) => { if (event.key === 'Escape') closeMenu(); }}>
    <header className="viewer-toolbar">
      <button ref={menuButton} className="viewer-menu-button" aria-controls="viewer-services"
        aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰ サービス</button>
      <strong>{active?.name ?? 'Ex Viewer'}</strong>
      <span className="viewer-load" role="status">{loading && active ? '読み込み中…' : ''}</span>
      {active && <button onClick={() => { setLoading(true); setFrameKey((key) => key + 1); }}>再読込</button>}
    </header>
    <div className="viewer-body">
      {menuOpen && <button className="viewer-menu-backdrop" aria-label="サービスメニューを閉じる"
        onClick={closeMenu} />}
      {menuOpen && <aside className="viewer-menu" id="viewer-services" aria-label="サービス切り替え">
        <label>サービスを探す<input ref={searchInput} type="search" value={query}
          onChange={(event) => setQuery(event.target.value)} placeholder="名前で検索" /></label>
        {error && <p role="alert">{error}</p>}
        {visible.map((service) => <button key={service.code} disabled={!!service.excludedReason}
          className={[selected === service.code ? 'active' : '', service.status === 'down' ? 'is-down' : ''].filter(Boolean).join(' ')}
          onClick={() => select(service)}>
          <span>{service.name}</span>
          {service.status === 'down' && <small className="viewer-service-status">停止中</small>}
          {service.excludedReason && <small>{service.excludedReason}</small>}
        </button>)}
        {!error && services.length > 0 && visible.length === 0 && <p>該当するサービスはありません。</p>}
      </aside>}
      <main className="viewer-content">
        {active ? <iframe key={`${active.code}-${frameKey}`} src={active.href} title={active.name}
          onLoad={(event) => {
            // Location.assign/href cannot be overridden by a compatibility script.
            // Re-enter the service namespace after a same-origin full navigation.
            try {
              const frame = event.currentTarget;
              const address = frame.contentWindow?.location;
              if (address && address.origin === location.origin && !address.pathname.startsWith('/viewer/')) {
                frame.src = `/viewer/apps/${active.code}${address.pathname}${address.search}${address.hash}`;
                return;
              }
            } catch { /* An external login page owns its own origin until it returns. */ }
            setLoading(false);
          }} referrerPolicy="same-origin"
          allow="clipboard-read; clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals" />
          : <div className="viewer-empty"><h1>Ex Viewer</h1><p>{error || (services.length ? 'メニューからサービスを選択してください。' : 'サービス一覧を読み込んでいます…')}</p></div>}
      </main>
    </div>
  </div>;
}
