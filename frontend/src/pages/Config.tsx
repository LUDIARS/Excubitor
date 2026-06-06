import { useEffect, useState } from 'react';
import {
  fetchConfig,
  fetchCatalogServices,
  saveIdentity,
  saveServices,
  type CatalogService,
  type ConfigInfisical,
  type ServiceInfisical,
} from '../lib/api';

interface SvcRow extends ServiceInfisical {
  code: string;
}

function toRows(map: Record<string, ServiceInfisical>): SvcRow[] {
  return Object.entries(map).map(([code, v]) => ({ code, ...v }));
}

function toMap(rows: SvcRow[]): Record<string, ServiceInfisical> {
  const out: Record<string, ServiceInfisical> = {};
  for (const r of rows) {
    if (!r.code.trim() || !r.project_id.trim()) continue;
    out[r.code.trim()] = {
      project_id: r.project_id.trim(),
      environment: r.environment || 'dev',
      inject: r.inject,
      prefix: r.prefix ?? '',
      include: r.include,
      exclude: r.exclude,
    };
  }
  return out;
}

export default function Config() {
  const [cfg, setCfg] = useState<ConfigInfisical | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // identity form
  const [siteUrl, setSiteUrl] = useState('https://app.infisical.com');
  const [environment, setEnvironment] = useState('dev');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  // services editor
  const [rows, setRows] = useState<SvcRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogService[]>([]);

  const load = async () => {
    const [c, svcs] = await Promise.all([fetchConfig(), fetchCatalogServices().catch(() => [])]);
    setCfg(c);
    setCatalog(svcs);
    if (c.identity.siteUrl) setSiteUrl(c.identity.siteUrl);
    if (c.identity.environment) setEnvironment(c.identity.environment);
    setRows(toRows(c.services));
  };

  useEffect(() => {
    void load();
  }, []);

  const submitIdentity = async () => {
    setBusy('identity');
    try {
      await saveIdentity({ siteUrl, environment, clientId, clientSecret });
      setClientId('');
      setClientSecret('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const submitServices = async () => {
    setBusy('services');
    try {
      await saveServices(toMap(rows));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const updateRow = (i: number, patch: Partial<SvcRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((rs) => [...rs, { code: '', project_id: '', environment: 'dev', inject: true, prefix: '' }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  if (!cfg) return <div className="config">読み込み中…</div>;

  const id = cfg.identity;

  return (
    <div className="config">
      <section className="config-card">
        <h2>Infisical machine identity</h2>
        <p className="muted">
          Excubitor が secret を取得するための machine identity。
          {id.configured ? (
            <> 現在: <strong>設定済み</strong> ({id.siteUrl} / clientId {id.clientIdHint})</>
          ) : (
            <> 現在: <strong className="fail">未設定</strong> — 入力してください</>
          )}
        </p>
        <p className="muted small">
          保存先 (暗号化): <code>{id.storePath}</code> — リポジトリ外 (AppData) に salt 付き暗号化で保存。
        </p>
        <div className="config-form">
          <label>Site URL<input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} /></label>
          <label>Environment<input value={environment} onChange={(e) => setEnvironment(e.target.value)} /></label>
          <label>Client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={id.configured ? '(変更時のみ入力)' : ''} /></label>
          <label>Client Secret<input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={id.configured ? '(変更時のみ入力)' : ''} /></label>
          <button
            className="primary"
            disabled={busy !== null || !siteUrl || !clientId || !clientSecret}
            onClick={() => void submitIdentity()}
          >
            {busy === 'identity' ? '保存中…' : '保存 (暗号化)'}
          </button>
        </div>
      </section>

      <section className="config-card">
        <h2>サービス別 Infisical マッピング</h2>
        <p className="muted">
          各サービスがどの Infisical project から env を受け取るか。ここに入れた設定を catalog より優先。
          service code は catalog 登録名から選択 (タイプミス防止)。
        </p>
        <table className="config-table">
          <thead>
            <tr><th>service code</th><th>project_id</th><th>environment</th><th>prefix</th><th>inject</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <select value={r.code} onChange={(e) => updateRow(i, { code: e.target.value })}>
                    <option value="">(選択)</option>
                    {catalog.map((s) => (
                      <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                    ))}
                    {r.code && !catalog.some((s) => s.code === r.code) && (
                      <option value={r.code}>{r.code} (catalog 外)</option>
                    )}
                  </select>
                </td>
                <td><input value={r.project_id} onChange={(e) => updateRow(i, { project_id: e.target.value })} placeholder="uuid" /></td>
                <td><input value={r.environment} onChange={(e) => updateRow(i, { environment: e.target.value })} /></td>
                <td><input value={r.prefix} onChange={(e) => updateRow(i, { prefix: e.target.value })} /></td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={r.inject} onChange={(e) => updateRow(i, { inject: e.target.checked })} /></td>
                <td><button className="link" onClick={() => removeRow(i)}>削除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="config-actions">
          <button onClick={addRow}>+ 行を追加</button>
          <button className="primary" disabled={busy !== null} onClick={() => void submitServices()}>
            {busy === 'services' ? '保存中…' : 'マッピングを保存'}
          </button>
        </div>
      </section>
    </div>
  );
}
