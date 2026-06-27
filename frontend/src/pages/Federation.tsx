import { useEffect, useState } from 'react';
import {
  fetchPeers,
  fetchFederation,
  fetchSelfNode,
  addPeer,
  deletePeer,
  testPeer,
  updatePeer,
  remoteControl,
  remoteUpdate,
  type PeerView,
  type FederationView,
  type FederationNode,
  type SelfNode,
} from '../lib/api';

export default function Federation() {
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [view, setView] = useState<FederationView | null>(null);
  const [self, setSelf] = useState<SelfNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-peer form
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [cfId, setCfId] = useState('');
  const [cfSecret, setCfSecret] = useState('');

  const reload = async () => {
    try {
      const [p, v] = await Promise.all([fetchPeers(), fetchFederation()]);
      setPeers(p);
      setView(v);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void reload();
    void fetchSelfNode().then(setSelf).catch(() => {});
    const id = setInterval(() => void fetchFederation().then(setView).catch(() => {}), 10000);
    return () => clearInterval(id);
  }, []);

  const onAdd = async () => {
    if (!name || !baseUrl || !token) return;
    setBusy(true);
    try {
      await addPeer({
        name,
        base_url: baseUrl,
        token,
        ...(cfId && cfSecret ? { cf_access_id: cfId, cf_access_secret: cfSecret } : {}),
      });
      setName('');
      setBaseUrl('');
      setToken('');
      setCfId('');
      setCfSecret('');
      await reload();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (id: string) => {
    setBusy(true);
    try {
      await testPeer(id);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    setBusy(true);
    try {
      await deletePeer(id);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (p: PeerView) => {
    setBusy(true);
    try {
      await updatePeer(p.id, { enabled: !p.enabled });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="federation">
      {error && <div className="error-banner">エラー: {error}</div>}

      <SelfNodePanel self={self} />

      <h2 className="mem-section-title">他拠点ピア</h2>
      <div className="peer-add foundation-form">
        <input placeholder="拠点名 (例: 自宅PC)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="base_url (例: https://host:17332)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input placeholder="agent token" value={token} onChange={(e) => setToken(e.target.value)} type="password" />
        <input placeholder="CF-Access Client Id (任意)" value={cfId} onChange={(e) => setCfId(e.target.value)} />
        <input placeholder="CF-Access Client Secret (任意)" value={cfSecret} onChange={(e) => setCfSecret(e.target.value)} type="password" />
        <button disabled={busy || !name || !baseUrl || !token} onClick={() => void onAdd()}>
          追加
        </button>
      </div>
      <p className="muted">
        相手ノードが Cloudflare Access の後ろにある場合のみ CF-Access の Service Token を入力 (両方揃えば送信)。 token / secret は暗号化保存。
      </p>

      {peers.length === 0 ? (
        <div className="empty-state">ピア未登録。 相手 Excubitor の base_url と agent token を登録すると集約します。</div>
      ) : (
        <table className="peer-table">
          <thead>
            <tr>
              <th>拠点</th><th>URL</th><th>token</th><th>状態</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {peers.map((p) => (
              <tr key={p.id} className={p.enabled ? '' : 'disabled'}>
                <td>{p.name}</td>
                <td className="mono">{p.base_url}</td>
                <td className="mono">{p.token_hint}{p.cf_access_id ? ' · CF✓' : ''}</td>
                <td>
                  {p.last_error ? <span className="bad">NG: {p.last_error}</span> : p.last_ok_at ? <span className="ok">OK</span> : '—'}
                </td>
                <td className="peer-actions">
                  <button disabled={busy} onClick={() => void onTest(p.id)}>疎通</button>
                  <button disabled={busy} onClick={() => void onToggle(p)}>{p.enabled ? '無効化' : '有効化'}</button>
                  <button disabled={busy} className="danger" onClick={() => void onDelete(p.id)}>削除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mem-section-title">集約ビュー (local + ピア)</h2>
      {view === null ? (
        <div className="empty-state">読み込み中…</div>
      ) : (
        <div className="node-grid">
          <NodeCard node={view.local} />
          {view.peers.map((n) => (
            <NodeCard key={n.peer_id ?? n.name} node={n} onControl={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 本ノードの federation 名 + agent token。 相手ノードに貼ってピア登録するための導線。 */
function SelfNodePanel({ self }: { self: SelfNode | null }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!self) return null;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(self.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setRevealed(true); // クリップボード不可なら手動コピーできるよう表示する
    }
  };

  return (
    <section className="self-node foundation-form">
      <h2 className="mem-section-title">このノード</h2>
      <div className="self-node-row">
        <span className="self-node-name">{self.node}</span>
        <code className="self-token mono">{revealed ? self.token : `…${self.token.slice(-4)}`}</code>
        <button onClick={() => setRevealed((v) => !v)}>{revealed ? '隠す' : '表示'}</button>
        <button onClick={() => void onCopy()}>{copied ? 'コピー済' : 'token をコピー'}</button>
      </div>
      <p className="self-node-hint muted">
        この token を相手ノードの「他拠点ピア」登録に貼ると、 相手から本ノードへ接続できます。
      </p>
    </section>
  );
}

function NodeCard({ node, onControl }: { node: FederationNode; onControl?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const s = node.summary;
  const isRemote = node.peer_id != null;

  const doControl = async (code: string, action: 'start' | 'stop' | 'restart') => {
    if (!node.peer_id) return;
    setBusy(true);
    try {
      await remoteControl(node.peer_id, code, action);
      if (onControl) await onControl();
    } finally {
      setBusy(false);
    }
  };

  const doPull = async (code: string) => {
    if (!node.peer_id) return;
    setBusy(true);
    try {
      const res = await remoteUpdate(node.peer_id, code);
      if (!res.ok) alert(`更新失敗 (${code}): ${res.error ?? 'unknown'}`);
      if (onControl) await onControl();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`node-card ${node.ok ? '' : 'node-down'}`}>
      <div className="node-head">
        <span className="node-name">{node.node ?? node.name}{isRemote ? '' : ' (local)'}</span>
        {!node.ok && <span className="bad">接続不可: {node.error}</span>}
      </div>
      {node.host && (
        <div className="node-host">
          CPU {node.host.cpu_pct != null ? `${node.host.cpu_pct}%` : '—'}
          {' · '}メモリ {fmtGiB(node.host.used_mem_bytes)} / {fmtGiB(node.host.totalMemBytes)}
        </div>
      )}
      {s && (
        <div className="node-summary">
          稼働 {s.up} / 全 {s.services_total} · エラー {s.open_errors}
        </div>
      )}
      <ul className="node-services">
        {node.services.slice(0, 50).map((svc) => (
          <li key={svc.code} className={`svc-${svc.state}`}>
            <span className="svc-state-dot" data-state={svc.state} />
            <span className="svc-name">{svc.name}</span>
            <span className="svc-branch mono">{svc.git_branch ?? ''}</span>
            {isRemote && node.ok && (
              <span className="svc-actions">
                <button disabled={busy} onClick={() => void doPull(svc.code)} title="git pull (更新)">更新</button>
                <button disabled={busy} onClick={() => void doControl(svc.code, 'restart')}>再起動</button>
                <button disabled={busy} onClick={() => void doControl(svc.code, 'start')}>起動</button>
                <button disabled={busy} onClick={() => void doControl(svc.code, 'stop')}>停止</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

function fmtGiB(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return '—';
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}
