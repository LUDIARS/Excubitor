import { useEffect, useState } from 'react';
import {
  fetchUpdates,
  applyUpdate,
  fetchDiscovery,
  fetchTopology,
  type UpdateStatus,
  type DiscoveryResult,
} from '../lib/api';

/**
 * プロダクトランチャー: アップデートの確認/配信 + 新規サービスの確認。
 * 起動セットの選択は Launch タブ、 死活監視は Monitor タブ。
 */
export default function Launcher() {
  const [updates, setUpdates] = useState<UpdateStatus[] | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [topology, setTopology] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadUpdates = async (fetch: boolean) => {
    setBusy(fetch ? 'fetch' : 'load');
    setMsg(null);
    try {
      setUpdates(await fetchUpdates(fetch));
    } catch (e) {
      setMsg(`更新確認失敗: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const loadDiscovery = async () => {
    try {
      setDiscovery(await fetchDiscovery());
    } catch (e) {
      setMsg(`検出失敗: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    void loadUpdates(false);
    void loadDiscovery();
    void fetchTopology().then(setTopology).catch(() => {});
  }, []);

  const doUpdate = async (code: string) => {
    if (!window.confirm(`${code} を最新化 (git pull + npm install + restart) しますか?`)) return;
    setBusy(`update:${code}`);
    setMsg(null);
    try {
      const r = await applyUpdate(code, {});
      const summary = r.steps.map((s) => `${s.ok ? '✓' : '✗'}${s.step}`).join(' ');
      setMsg(`${code}: ${r.ok ? '更新完了' : '失敗'} — ${summary}`);
      await loadUpdates(false);
    } catch (e) {
      setMsg(`${code} 更新失敗: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const available = (updates ?? []).filter((u) => u.available);

  return (
    <div className="launcher">
      {msg && <div className="launcher-msg">{msg}</div>}

      <section className="config-card">
        <div className="launcher-head">
          <h2>アップデート</h2>
          <div className="config-actions">
            <button disabled={busy !== null} onClick={() => void loadUpdates(false)}>
              {busy === 'load' ? '…' : '再読込'}
            </button>
            <button className="primary" disabled={busy !== null} onClick={() => void loadUpdates(true)}>
              {busy === 'fetch' ? '取得中…' : 'origin を取得して確認'}
            </button>
          </div>
        </div>
        <p className="muted">
          各サービス (git リポジトリ) の HEAD と origin/&lt;branch&gt; を比較。
          「origin を取得して確認」 で fetch してから behind を数える。
        </p>
        {updates === null ? (
          <p className="muted">読み込み中…</p>
        ) : available.length === 0 ? (
          <p className="muted">アップデート可能なサービスはありません{updates.some((u) => !u.fetched) ? '(未 fetch — origin 取得を実行してください)' : ''}。</p>
        ) : (
          <table className="config-table">
            <thead>
              <tr><th>service</th><th>branch</th><th>behind</th><th>ahead</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {available.map((u) => (
                <tr key={u.code}>
                  <td>{u.code}</td>
                  <td><code>{u.branch}</code></td>
                  <td className="num">{u.behind}</td>
                  <td className="num">{u.ahead}</td>
                  <td>{u.dirty && <span className="dirty-flag">dirty</span>}</td>
                  <td>
                    <button
                      className="primary"
                      disabled={busy !== null || u.dirty}
                      title={u.dirty ? '未コミット変更があるため更新不可' : ''}
                      onClick={() => void doUpdate(u.code)}
                    >
                      {busy === `update:${u.code}` ? '更新中…' : '更新'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="config-card">
        <div className="launcher-head">
          <h2>新規サービスの確認</h2>
          <div className="config-actions">
            <button disabled={busy !== null} onClick={() => void loadDiscovery()}>再スキャン</button>
          </div>
        </div>
        <p className="muted">
          Ars ワークスペース ({discovery?.scannedRoot ?? '…'}) の git リポジトリのうち、
          catalog 未登録のものと clone 欠落のもの。 登録は <code>catalog/services.yaml</code> に追記。
        </p>
        {discovery === null ? (
          <p className="muted">読み込み中…</p>
        ) : (
          <>
            <h3 className="launcher-sub">未登録の候補 ({discovery.candidates.length})</h3>
            {discovery.candidates.length === 0 ? (
              <p className="muted">未登録のリポジトリはありません。</p>
            ) : (
              <table className="config-table">
                <thead>
                  <tr><th>name</th><th>runtime 推定</th><th>dev script</th><th>path</th></tr>
                </thead>
                <tbody>
                  {discovery.candidates.map((d) => (
                    <tr key={d.path}>
                      <td>{d.name}</td>
                      <td>{d.suggestedRuntime}</td>
                      <td>{d.hasDevScript ? '✓' : '—'}</td>
                      <td><code className="path">{d.path}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {discovery.missing.length > 0 && (
              <>
                <h3 className="launcher-sub">clone 欠落 ({discovery.missing.length})</h3>
                <table className="config-table">
                  <thead><tr><th>service</th><th>期待 path</th></tr></thead>
                  <tbody>
                    {discovery.missing.map((m) => (
                      <tr key={m.code}>
                        <td>{m.code}</td>
                        <td><code className="path">{m.repoDir}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      <section className="config-card">
        <h2>注入される topology env</h2>
        <p className="muted">
          Excubitor が catalog から導出し、 起動する全サービスへ注入する URL/port
          (各サービスが個別設定しなくてよい接続先)。 secret は別途 Infisical で解決。
        </p>
        {topology === null ? (
          <p className="muted">読み込み中…</p>
        ) : Object.keys(topology).length === 0 ? (
          <p className="muted">port を持つサービスがありません。</p>
        ) : (
          <table className="config-table">
            <thead><tr><th>env</th><th>value</th></tr></thead>
            <tbody>
              {Object.entries(topology)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <tr key={k}><td><code>{k}</code></td><td><code className="path">{v}</code></td></tr>
                ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
