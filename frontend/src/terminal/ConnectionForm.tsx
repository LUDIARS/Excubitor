import { useState } from 'react';
import { terminalRequest, type TerminalCredentials, type TerminalProfile } from './api';

/** @implements SPEC-TERMINAL-CONNECTIONS */
export default function ConnectionForm({ initial, onSaved, onCancel }: {
  initial?: TerminalProfile; onSaved: () => void; onCancel: () => void;
}) {
  const [profile, setProfile] = useState<TerminalProfile>(() => initial ?? {
    id: crypto.randomUUID(), serverName: '', host: '', port: 22, network: 'private', auth: 'password', hostKey: '',
  });
  const [credentials, setCredentials] = useState<TerminalCredentials>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(!!initial);
  const changeTarget = (change: Partial<TerminalProfile>) => { setProfile({ ...profile, ...change, hostKey: '' }); setVerified(false); };
  const credential = (name: keyof TerminalCredentials, value: string) => setCredentials({ ...credentials, [name]: name === 'passphrase' ? value : value || undefined });
  const inspect = async () => {
    setBusy(true); setError('');
    try {
      const result = await terminalRequest<{ hostKey: string }>('/inspect', 'POST', {
        host: profile.host, port: profile.port, network: profile.network, auth: profile.auth,
      });
      setProfile({ ...profile, hostKey: result.hostKey }); setVerified(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      await terminalRequest(`/profiles/${profile.id}`, 'PUT', { profile, credentials });
      setCredentials({}); onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="terminal-form">
    <h3>{initial ? '接続先を編集' : '接続先を追加'}</h3>
    <fieldset disabled={busy}>
      <label>サーバー名（表示名）<input required value={profile.serverName} onChange={(e) => setProfile({ ...profile, serverName: e.target.value })} /></label>
      <label>ホスト名・IPアドレス<input required value={profile.host} onChange={(e) => changeTarget({ host: e.target.value })} placeholder="server.example.com" /></label>
      <label>ポート<input type="number" min={1} max={65535} required value={profile.port} onChange={(e) => changeTarget({ port: Number(e.target.value) })} /></label>
      <label>接続範囲<select value={profile.network} onChange={(e) => changeTarget({ network: e.target.value as TerminalProfile['network'], auth: e.target.value === 'external' ? 'key' : profile.auth })}>
        <option value="private">LAN・VPN内</option><option value="external">外部</option>
      </select></label>
      <label>認証方式<select value={profile.auth} onChange={(e) => changeTarget({ auth: e.target.value as TerminalProfile['auth'] })}>
        {profile.network === 'private' && <option value="password">パスワード</option>}<option value="key">SSH鍵</option>
      </select></label>
      <p>どちらもSSHの暗号化通信です。認証情報はVaultに保存します。編集時の空欄は登録済みの値を維持します。</p>
      <label>ログイン名<input autoComplete="off" required={!initial} value={credentials.username ?? ''} onChange={(e) => credential('username', e.target.value)} /></label>
      {profile.auth === 'password'
        ? <label>パスワード<input type="password" autoComplete="new-password" required={!initial || initial.auth !== 'password'} value={credentials.password ?? ''} onChange={(e) => credential('password', e.target.value)} /></label>
        : <><label>SSH秘密鍵<textarea autoComplete="off" required={!initial || initial.auth !== 'key'} value={credentials.privateKey ?? ''} onChange={(e) => credential('privateKey', e.target.value)} /></label>
          <label>鍵のパスフレーズ（必要な場合）<input type="password" autoComplete="new-password" value={credentials.passphrase ?? ''} onChange={(e) => credential('passphrase', e.target.value)} /></label></>}
      <button type="button" onClick={() => void inspect()}>接続先のホスト鍵を取得</button>
      {profile.hostKey && <><code className="terminal-key">{profile.hostKey}</code>
        <label><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> サーバー管理者の情報と照合しました</label></>}
      <button type="submit" disabled={!verified || !profile.hostKey}>保存</button> <button type="button" onClick={onCancel}>閉じる</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </form>;
}
