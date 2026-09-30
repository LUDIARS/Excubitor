import { useEffect, useState } from 'react';
import { fetchPeers, type PeerView } from '../lib/api';
import {
  deleteVaultEntry,
  fetchVaultStatus,
  importVaultFromInfisical,
  saveVaultBindings,
  saveVaultEntry,
  saveVaultSource,
  type VaultStatus,
} from '../lib/vault';

/**
 * Vault (Infisical の置き換え)。本社で値を持ち、サービスごとに「使用する環境変数」を紐付ける。
 * 拠点は取得元 (本社のピア) を選ぶだけで、起動時に本社から受け取る。値はこの画面にも出さない。
 */
export function VaultCard() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindNames, setBindNames] = useState('');
  const [importCode, setImportCode] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [nextStatus, nextPeers] = await Promise.all([fetchVaultStatus(), fetchPeers().catch(() => [])]);
    setStatus(nextStatus);
    setPeers(nextPeers);
  };

  useEffect(() => { void load().catch((err: Error) => setMessage({ ok: false, text: err.message })); }, []);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await action() });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <section className="config-card"><h2>Vault</h2><p>読み込み中…</p></section>;

  const splitNames = (text: string) => text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);

  return (
    <section className="config-card">
      <h2>Vault (環境変数)</h2>
      <p className="muted">
        値は暗号化して保存し、サービス起動時にだけ env として渡す (鍵の保管: {status.keystore === 'dpapi' ? 'Windows DPAPI' : '0600 ファイル'})。
        画面と API は値を返さない。確かめたいときは差し替える。
      </p>

      <h3>取得元</h3>
      <label title="本社は「この拠点が本社」のまま。拠点は本社のピアを選ぶと、起動時に本社から受け取り、本社に届かないときは前回の控えを使う">
        <select
          value={status.source_peer_id ?? ''}
          disabled={busy}
          onChange={(event) => void run(async () => {
            await saveVaultSource(event.target.value || null);
            return '取得元を保存しました';
          })}
        >
          <option value="">この拠点が本社 (自分の Vault を使う)</option>
          {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name} から受け取る</option>)}
        </select>
      </label>
      {status.cached_services.length > 0 && (
        <p className="muted">
          控え: {status.cached_services.map((entry) => `${entry.code} (${new Date(entry.fetched_at).toLocaleString()})`).join(', ')}
        </p>
      )}

      <h3>値</h3>
      <table className="config-table">
        <thead><tr><th>名前</th><th>使うサービス</th><th>更新</th><th /></tr></thead>
        <tbody>
          {status.entries.map((entry) => (
            <tr key={entry.name}>
              <td><code>{entry.name}</code></td>
              <td>{entry.used_by.join(', ') || '—'}</td>
              <td>{new Date(entry.updated_at).toLocaleString()}</td>
              <td>
                <button
                  disabled={busy}
                  title="この値を削除する (紐付けは残り、未登録として表示される)"
                  onClick={() => void run(async () => { await deleteVaultEntry(entry.name); return `${entry.name} を削除しました`; })}
                >削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="config-row">
        <input placeholder="DATABASE_URL" value={name} onChange={(event) => setName(event.target.value)} title="環境変数名 (英数字と _)" />
        <input type="password" placeholder="値" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" title="保存後は表示されない" />
        <button
          className="primary"
          disabled={busy || !name.trim() || !value}
          title="値を登録する。同名があれば差し替える"
          onClick={() => void run(async () => {
            await saveVaultEntry(name.trim(), value);
            setValue('');
            return `${name.trim()} を保存しました`;
          })}
        >保存</button>
      </div>

      <h3>使用する環境変数 (サービスごと)</h3>
      <table className="config-table">
        <thead><tr><th>サービス</th><th>環境変数</th></tr></thead>
        <tbody>
          {Object.entries(status.bindings).map(([code, names]) => (
            <tr key={code}>
              <td><code>{code}</code></td>
              <td>{names.map((entry) => (
                <span key={entry.name} className={entry.present ? '' : 'error'} title={entry.present ? '登録済み' : '値が未登録 (このままだと起動を止める)'}>
                  {entry.name}{entry.present ? '' : ' (未登録)'}{' '}
                </span>
              ))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="config-row">
        <input placeholder="サービスコード" value={bindCode} onChange={(event) => setBindCode(event.target.value)} />
        <input placeholder="DATABASE_URL, API_KEY" value={bindNames} onChange={(event) => setBindNames(event.target.value)} title="空にして保存すると紐付けを外す" />
        <button
          disabled={busy || !bindCode.trim()}
          title="このサービスが起動時に受け取る環境変数を置き換える"
          onClick={() => void run(async () => {
            await saveVaultBindings(bindCode.trim(), splitNames(bindNames));
            return `${bindCode.trim()} の紐付けを保存しました`;
          })}
        >紐付けを保存</button>
      </div>

      <h3>Infisical から移す</h3>
      <div className="config-row">
        <input placeholder="サービスコード" value={importCode} onChange={(event) => setImportCode(event.target.value)} />
        <button
          disabled={busy || !importCode.trim()}
          title="そのサービスの Infisical マッピングで取れる値を Vault に保存し、紐付けに足す"
          onClick={() => void run(async () => {
            const result = await importVaultFromInfisical(importCode.trim());
            return `${result.imported.length} 件を取り込みました: ${result.imported.join(', ')}`;
          })}
        >取り込む</button>
      </div>

      {message && <p className={message.ok ? 'ok' : 'error'}>{message.text}</p>}
    </section>
  );
}
