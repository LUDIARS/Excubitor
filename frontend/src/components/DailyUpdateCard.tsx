/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { useEffect, useState } from 'react';

interface Settings { enabled: boolean; time: string; timezone: string }
interface Run {
  id: string; startedAt: string; status: string; recoveryPending: boolean; notification: string | null;
  events: { repository: string; status: string; detail: string }[];
}
async function request<T>(method: string, settings?: Settings): Promise<T> {
  const res = await fetch('/api/v1/daily-update', {
    method, headers: { 'content-type': 'application/json' },
    body: settings ? JSON.stringify(settings) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail && typeof data.detail === 'string' ? data.detail : data.error ?? `HTTP ${res.status}`);
  return data as T;
}
export default function DailyUpdateCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let disposed = false;
    void request<{ settings: Settings; runs: Run[] }>('GET').then((data) => {
      if (!disposed) { setSettings(data.settings); setRuns(data.runs); }
    }).catch((err: Error) => { if (!disposed) setError(err.message); });
    return () => { disposed = true; };
  }, []);
  const save = async () => {
    if (!settings) return;
    setBusy(true); setSaved(false); setError('');
    try { await request('PUT', settings); setSaved(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const recover = async (id: string) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/v1/daily-update/runs/${encodeURIComponent(id)}/recover`, { method: 'POST' });
      if (!res.ok) throw new Error('復旧を開始できません。他の操作が完了してから再試行してください。');
      setRuns((current) => current.map((run) => run.id === id ? { ...run, status: 'running' } : run));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="config-card">
    <h2>この拠点の毎朝の更新</h2>
    <p>リポジトリを更新し、変更があったサービスをビルド・再配置します。起動に失敗したら前の版に戻し、復旧にも失敗した場合はエラーを通知します。</p>
    <p className="muted">停止中のサービスは起動しません。作業中の変更があるリポジトリはスキップします。保存時には実行せず、指定時刻から1時間以内に一度実行します。</p>
    {error && <p role="alert" className="fail">{error}</p>}
    {settings && <div className="config-form">
      <label><input type="checkbox" checked={settings.enabled} onChange={(e) => { setSaved(false); setSettings({ ...settings, enabled: e.target.checked }); }} /> 毎朝の自動更新を有効にする</label>
      <label>開始時刻<input type="time" value={settings.time} onChange={(e) => { setSaved(false); setSettings({ ...settings, time: e.target.value }); }} /></label>
      <label>タイムゾーン<input value={settings.timezone} onChange={(e) => { setSaved(false); setSettings({ ...settings, timezone: e.target.value }); }} placeholder="Asia/Tokyo" /></label>
      <p className="muted">復旧失敗は Errors に記録します。Discord 通知は下の Discord 設定で有効にしてください。</p>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : 'この拠点の設定を保存'}</button>
      {saved && <p role="status">保存しました。</p>}
    </div>}
    {runs.slice(0, 5).map((run) => <details key={run.id}>
      <summary>{new Date(run.startedAt).toLocaleString()} — {run.status}{run.recoveryPending ? '（復旧確認が必要）' : ''}</summary>
      {run.notification && <p>{run.notification}</p>}
      {run.recoveryPending && run.status === 'failed' && <button disabled={busy} onClick={() => void recover(run.id)}>前の版への復旧を再試行</button>}
      <ul>{run.events.map((event, index) => <li key={index}>{event.repository.split(/[\\/]/).pop()}: {event.status} — {event.detail}</li>)}</ul>
    </details>)}
  </section>;
}
