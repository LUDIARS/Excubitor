import { useState } from 'react';
import type { OverviewSite, OverviewService } from '../../../src/overview/model';
import { controlService, type ControlAction } from '../lib/api';
import ServiceSettings from './ServiceSettings';
export const stateLabel = { up: '稼働', partial: '一部稼働', down: 'ダウン' };
/** @implements SPEC-EX-SERVICE-OVERVIEW */
export default function ServiceDetail({ site, service }: { site: OverviewSite; service: OverviewService }) {
  const [selected, setSelected] = useState(service.components[0]?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const component = service.components.find(c => c.code === selected) ?? service.components[0];
  const control = async (action: ControlAction) => {
    if (!component) return;
    setBusy(true); setMessage('');
    try { await controlService(component.code, action); setMessage('操作を受け付けました。状態は次回の監視で更新されます。'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <a className="ex-back" href="#overview">← サービス一覧へ</a>
    <header className="ex-title"><div><span className="ex-eyebrow">{site.name} / SERVICE</span><h2>{service.name}</h2><p>{service.components.length} 個の内部サービス</p></div><span className={'ex-state '+service.state}>{stateLabel[service.state]}</span></header>
    {(site.stale || !site.connected) && <p className="ex-message">この拠点の最新状態は確認できていません。前回の観測結果を表示しています。</p>}
    <div className="ex-detail-grid"><nav className="ex-component-list" aria-label="内部サービス">
      {service.components.map(c => <button key={c.code} className={component?.code === c.code ? 'selected' : ''} onClick={() => setSelected(c.code)}><strong>{c.name}</strong><span className={'ex-state '+c.state}>{stateLabel[c.state]}</span><small>{c.version ?? 'バージョン未報告'}{c.startup ? ' · スタートアップ' : ''}{!c.observed ? ' · 未観測' : ''}</small></button>)}
    </nav><section className="ex-component-detail">
      {component && <><div className="ex-detail-heading"><div><h3>{component.name}</h3><code>{component.code}</code></div>{site.local && <div className="ex-actions">{(['start','restart','stop'] as const).map((a,i) => <button key={a} disabled={busy || (component.disabled && a !== 'stop')} onClick={() => void control(a)}>{['起動','再起動','停止'][i]}</button>)}</div>}</div>
      {message && <p className="ex-message" role="status">{message}</p>}
      {site.local ? <ServiceSettings key={component.code} component={component} /> : <p>他拠点の操作は <a href="#federation">Federation</a> から、設定編集は対象 PC の Excubitor で行ってください。</p>}
      </>}
    </section></div>
  </>;
}
