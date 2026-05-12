import { useEffect, useState } from 'react';
import type { InfisicalSecret, InfisicalStatus } from '../lib/api';
import {
  fetchInfisicalStatus,
  fetchInfisicalSecrets,
  infisicalBootstrap,
  infisicalForget,
  upsertInfisicalSecret,
  deleteInfisicalSecret,
} from '../lib/api';

export default function Infisical() {
  const [status, setStatus] = useState<InfisicalStatus | null>(null);
  const [siteUrl, setSiteUrl] = useState('https://infisical.vtn-game.com');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [environment, setEnvironment] = useState('dev');
  const [secrets, setSecrets] = useState<InfisicalSecret[] | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const refresh = async () => setStatus(await fetchInfisicalStatus());

  useEffect(() => {
    void refresh();
  }, []);

  const onBootstrap = async () => {
    try {
      await infisicalBootstrap({ site_url: siteUrl, client_id: clientId, client_secret: clientSecret });
      setClientSecret(''); // 入力欄を即時クリア (画面上から除去)
      await refresh();
    } catch (err) {
      alert(`bootstrap failed: ${(err as Error).message}`);
    }
  };

  const onForget = async () => {
    await infisicalForget();
    setSecrets(null);
    await refresh();
  };

  const onListSecrets = async () => {
    try {
      const data = await fetchInfisicalSecrets(workspaceId, environment);
      setSecrets(data.secrets);
    } catch (err) {
      alert(`fetch failed: ${(err as Error).message}`);
    }
  };

  const onSave = async (name: string, value: string) => {
    await upsertInfisicalSecret({ workspaceId, environment, secretName: name, secretValue: value });
    await onListSecrets();
  };

  const onDelete = async (name: string) => {
    if (!window.confirm(`${name} を削除しますか?`)) return;
    await deleteInfisicalSecret({ workspaceId, environment, secretName: name });
    await onListSecrets();
  };

  const onAdd = async () => {
    if (!newKey) return;
    await onSave(newKey, newValue);
    setNewKey('');
    setNewValue('');
  };

  return (
    <div className="infisical-page">
      <section className="bootstrap-section">
        <h3>Bootstrap</h3>
        {status?.bootstrapped ? (
          <div className="bootstrap-state">
            <div>✅ bootstrapped</div>
            <div className="muted">site: {status.site_url}</div>
            <div className="muted">expires: {status.expires_at} ({status.expires_in_sec}s)</div>
            <button onClick={() => void onForget()}>forget (再 bootstrap が必要に)</button>
          </div>
        ) : (
          <div className="bootstrap-form">
            <label>
              site_url
              <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://infisical.vtn-game.com" />
            </label>
            <label>
              client_id
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label>
              client_secret
              <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </label>
            <button onClick={() => void onBootstrap()} disabled={!clientId || !clientSecret}>
              bootstrap (メモリにのみ保持)
            </button>
            <div className="muted">
              ※ credential はファイル / DB に書き込まれず、process メモリにのみ保持されます。 server 再起動で消失します。
            </div>
          </div>
        )}
      </section>

      {status?.bootstrapped && (
        <section className="secrets-section">
          <h3>Secrets</h3>
          <div className="secrets-toolbar">
            <input
              placeholder="workspaceId (project_id)"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            />
            <input
              placeholder="environment (dev / staging / prod)"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
            <button onClick={() => void onListSecrets()} disabled={!workspaceId || !environment}>
              load
            </button>
          </div>

          {secrets !== null && (
            <>
              <table className="secrets-table">
                <thead>
                  <tr>
                    <th>key</th>
                    <th>value</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  {secrets.map((s) => (
                    <tr key={s.secretKey}>
                      <td><code>{s.secretKey}</code></td>
                      <td>
                        {reveal[s.secretKey] ? <code>{s.secretValue}</code> : <span className="muted">••••••</span>}
                      </td>
                      <td>
                        <button onClick={() => setReveal((r) => ({ ...r, [s.secretKey]: !r[s.secretKey] }))}>
                          {reveal[s.secretKey] ? 'hide' : 'show'}
                        </button>
                        <button
                          onClick={() => {
                            const v = window.prompt(`${s.secretKey} の新しい値`, s.secretValue);
                            if (v !== null) void onSave(s.secretKey, v);
                          }}
                        >
                          edit
                        </button>
                        <button onClick={() => void onDelete(s.secretKey)}>delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="secrets-add">
                <input placeholder="new key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
                <input placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
                <button onClick={() => void onAdd()} disabled={!newKey}>add</button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
