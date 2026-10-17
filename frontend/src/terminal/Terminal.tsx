import { useEffect, useState } from 'react';
import ConnectionForm from './ConnectionForm';
import { terminalRequest, type TerminalProfile, type CommandResult } from './api';
import './terminal.css';

/** @implements SPEC-TERMINAL-CONNECTIONS */
export default function Terminal() {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [editing, setEditing] = useState<TerminalProfile | 'new' | null>(null);
  const [selected, setSelected] = useState('');
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    try {
      const data = await terminalRequest<{ profiles: TerminalProfile[] }>('/profiles');
      // Discard server-only metadata so strict profile writes contain only the contract fields.
      setProfiles(data.profiles.map(({ id, serverName, host, port, network, auth, hostKey }) => ({ id, serverName, host, port, network, auth, hostKey })));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void reload(); }, []);
  const execute = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await terminalRequest<CommandResult>(`/profiles/${selected}/exec`, 'POST', { command })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (profile: TerminalProfile) => {
    if (!window.confirm(`${profile.serverName} の接続設定を削除しますか？ Vaultの認証情報は残ります。`)) return;
    setError('');
    try { await terminalRequest(`/profiles/${profile.id}`, 'DELETE'); if (selected === profile.id) setSelected(''); await reload(); }
    catch (e) { setError((e as Error).message); }
  };
  return <section className="terminal-page">
    <h2>ターミナル接続</h2>
    <p>登録したサーバーへSSHで接続します。LAN・VPN内ではパスワードまたは鍵、外部は鍵で接続できます。</p>
    <button disabled={busy} onClick={() => setEditing('new')}>接続先を追加</button>
    {editing && <ConnectionForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing}
      onSaved={() => { setEditing(null); void reload(); }} onCancel={() => setEditing(null)} />}
    <ul>{profiles.map((p) => <li key={p.id}>
      <strong>{p.serverName}</strong> — {p.host}:{p.port} / {p.network === 'private' ? 'LAN・VPN' : '外部'} / {p.auth === 'password' ? 'パスワード' : 'SSH鍵'}
      {' '}<button disabled={busy} onClick={() => setEditing(p)}>編集</button>{' '}<button disabled={busy} onClick={() => void remove(p)}>削除</button>
    </li>)}</ul>
    <h3>コマンドを実行</h3>
    <p>1回ずつ実行します。cdなどの状態は次の実行には引き継がれません。対話入力が必要なコマンドは使えません。</p>
    <form onSubmit={(e) => { e.preventDefault(); void execute(); }}>
      <label>接続先<select required disabled={busy} value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">選択してください</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.serverName}</option>)}
      </select></label>
      <label>コマンド<textarea required disabled={busy} maxLength={16384} value={command} onChange={(e) => setCommand(e.target.value)} /></label>
      <button disabled={busy || !selected || !command}>{busy ? '実行中…' : '実行'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite"><p>終了コード: {result.exitCode ?? 'なし'} {result.signal}</p><pre>{result.stdout}</pre><pre>{result.stderr}</pre></div>}
  </section>;
}
