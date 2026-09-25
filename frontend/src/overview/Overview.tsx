import { useEffect, useState } from 'react';
import type { ServiceOverview, OverviewState } from '../../../src/overview/model';
import ServiceDetail, { stateLabel } from './ServiceDetail';
import './overview.css';
/** @implements SPEC-EX-SERVICE-OVERVIEW */
export default function Overview({ route }: { route: string }) {
  const [data, setData] = useState<ServiceOverview | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const response = await fetch('/api/v1/overview', { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 503 ? '最初の状態を収集中です。しばらくお待ちください。' : '状態を取得できません。接続を確認してください。');
        const snapshot = await response.json() as ServiceOverview;
        if (!controller.signal.aborted) { setData(snapshot); setError(''); setNow(Date.now()); }
      } catch (e) { if (!controller.signal.aborted) { setError((e as Error).message); setNow(Date.now()); } }
      if (!controller.signal.aborted) timer = setTimeout(() => void read(), 10_000);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const parts = route.split('/').slice(1).map(s => { try { return decodeURIComponent(s); } catch { return ''; } });
  const site = data?.sites.find(s => s.id === parts[0]);
  const service = site?.services.find(s => s.code === parts[1]);
  const services = data?.sites.flatMap(s => s.services) ?? [];
  const stale = !!data && now - data.generated_at > data.stale_after_ms;
  return <div className="ex-overview">
    {error && <p className="ex-message" role="status">{error}{data ? ' 前回の結果を表示しています。' : ''}</p>}
    {stale && <p className="ex-message">表示データの更新が遅れています。</p>}
    {site && service ? <ServiceDetail key={site.id+'/'+service.code} site={site} service={service} /> : <>
      <header className="ex-title"><div><span className="ex-eyebrow">EXCUBITOR / OPERATIONS</span><h2>サービスの現在地。</h2><p>各拠点の稼働状況を、ひとつの場所で。</p></div><div className="ex-sync"><span className="ex-live-dot" />{data ? '更新 '+new Date(data.generated_at).toLocaleTimeString() : '状態を収集中'}</div></header>
      {parts.length > 1 && data && <p className="ex-message">指定されたサービスが見つかりません。現在の一覧を表示しています。</p>}
      <section className="ex-summary" aria-label="サービスの状態集計"><div><span>拠点 / PC</span><strong>{data?.sites.length ?? '—'}</strong><small>接続された運用環境</small></div>{(['up','partial','down'] as OverviewState[]).map(state => <div key={state} className={state}><span>{stateLabel[state]}</span><strong>{data ? services.filter(s => s.state === state).length : '—'}</strong><small>{state === 'up' ? 'すべての構成要素が稼働' : state === 'partial' ? '一部の構成要素が稼働' : '稼働確認なし・停止'}</small></div>)}</section>
      <div className="ex-toolbar"><label className="ex-search">検索<input placeholder="サービス名で検索…" value={query} onChange={e => setQuery(e.target.value)} /></label><div className="ex-filters">{[['all','すべて'],['startup','スタートアップ'],['attention','要確認']].map(([value,label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value!)}>{label}</button>)}</div><span className="ex-startup-legend">◆ スタートアップ起動</span></div>
      {data?.sites.map(site => {
        const visible = site.services.filter(s => (s.name+' '+s.code).toLowerCase().includes(query.toLowerCase()) && (filter !== 'startup' || s.startup) && (filter !== 'attention' || s.state !== 'up' || site.stale || !site.connected));
        return <section className="ex-site" key={site.id}><header><div className="ex-site-icon">▦</div><div><h3>{site.name}</h3><p>{site.local ? 'この PC' : 'リモート拠点'} · {site.services.length} サービス</p></div><span className="ex-site-freshness">{!site.connected ? '接続できません' : site.stale ? '観測データが古い / 未取得' : '観測済み'}{site.checked_at ? ' · '+new Date(site.checked_at).toLocaleTimeString() : ''}</span></header>
          <div className="ex-table-wrap"><table><thead><tr><th>サービス</th><th>状態</th><th>バージョン</th><th>構成</th><th><span className="ex-sr-only">詳細</span></th></tr></thead><tbody>{visible.map(s => <tr key={s.code} className={s.startup ? 'ex-startup-row' : ''}><td><a className="ex-service-link" href={'#overview/'+encodeURIComponent(site.id)+'/'+encodeURIComponent(s.code)}><strong>{s.name}</strong><small>{s.code}{s.startup && <span className="ex-startup-tag">◆ スタートアップ</span>}</small></a></td><td><span className={'ex-state '+s.state}>{stateLabel[s.state]}</span>{!s.observed && <small className="ex-unobserved">未観測を含む</small>}</td><td className="ex-version">{s.versions.length ? s.versions.join(' / ') : '未報告'}</td><td>{s.components.length} コンポーネント</td><td><a className="ex-open" aria-label={s.name+' の詳細'} href={'#overview/'+encodeURIComponent(site.id)+'/'+encodeURIComponent(s.code)}>↗</a></td></tr>)}</tbody></table></div>
          {!visible.length && <p className="ex-empty">{site.services.length ? '条件に一致するサービスがありません。' : 'サービス情報はまだ取得できていません。'}</p>}
        </section>;
      })}
      {!data && !error && <p className="ex-empty">各拠点の状態を読み込んでいます…</p>}
      <footer className="ex-footer"><span>状態は定期観測の結果です。</span><a href="#monitor">従来の Monitor を開く ↗</a></footer>
    </>}
  </div>;
}
