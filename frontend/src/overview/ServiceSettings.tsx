import { useEffect, useState } from 'react';
import type { OverviewComponent } from '../../../src/overview/model';
import { fetchServiceRuntimeConfig, saveServiceRuntimeConfig, saveCatalogInfo, type ServiceRuntimeConfigStatus } from '../lib/api';
/** @implements SPEC-EX-SERVICE-SETTINGS */
export default function ServiceSettings({ component }: { component: OverviewComponent }) {
  const [status, setStatus] = useState<ServiceRuntimeConfigStatus | null>(null);
  const [json, setJson] = useState('');
  const [subdomain, setSubdomain] = useState(component.subdomain ?? '');
  const [url, setUrl] = useState(component.frontend_url ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void fetchServiceRuntimeConfig(component.code).then(s => { if (active) setStatus(s); })
      .catch(() => { if (active) setMessage('設定の状態を取得できません。開き直してください。'); });
    return () => { active = false; };
  }, [component.code]);
  const save = async (kind: 'host' | 'config') => {
    setBusy(true); setMessage('');
    try {
      if (kind === 'host') {
        await saveCatalogInfo(component.code, { subdomain: subdomain.trim() || null, frontend_url: url.trim() || null });
        setMessage('ホスト設定を保存しました。一覧には次回更新時に反映されます。');
      } else {
        let value: unknown;
        try { value = JSON.parse(json); } catch { throw new Error('有効な JSON オブジェクトを入力してください。'); }
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('設定は JSON オブジェクトで指定してください。');
        setStatus(await saveServiceRuntimeConfig(component.code, value as Record<string, unknown>));
        setJson('');
        setMessage('暗号化して保存しました。対象サービスがこの設定形式に対応していれば、次回起動時に反映されます。');
      }
    } catch (error) {
      // Runtime configuration can contain secrets: never echo payload or server diagnostics here.
      setMessage(kind === 'config' ? '設定を保存できません。JSON形式と接続状態を確認してください。' : (error as Error).message);
    } finally { setBusy(false); }
  };
  return <section className="ex-settings">
    <div><span className="ex-eyebrow">CONNECTION</span><h3>ホストと公開 URL</h3>
      <form onSubmit={e => { e.preventDefault(); void save('host'); }}>
        <label>サブドメイン<input value={subdomain} onChange={e => setSubdomain(e.target.value)} placeholder="service" /></label>
        <label>公開 URL<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://service.example.com" /></label>
        <p>ドメインの基準値は既存の Config 画面で設定できます。</p>
        <button disabled={busy} type="submit">ホスト設定を保存</button>
      </form>
    </div>
    <div><span className="ex-eyebrow">ENCRYPTED CONFIG</span><h3>暗号化されたサービス設定</h3>
      <p>{status ? status.configured ? '保存済みのキー: ' + status.keys.join(', ') : '設定は未登録です。' : '設定状態を取得中…'}</p>
      <form onSubmit={e => { e.preventDefault(); void save('config'); }}>
        <label>設定 JSON（全体を置換）<textarea value={json} onChange={e => setJson(e.target.value)} rows={10} spellCheck={false} autoComplete="off" placeholder={JSON.stringify({ hostname: 'example' }, null, 2)} /></label>
        <p>保存した値は再表示しません。全項目を入力してください。保存後の自動再起動は行いません。</p>
        <button disabled={busy || !json.trim() || !status} type="submit">暗号化して保存</button>
      </form>
    </div>
    {message && <p role="status" className="ex-message">{message}</p>}
  </section>;
}
