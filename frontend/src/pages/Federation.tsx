import { useCallback, useEffect, useState } from 'react';
import {
  fetchPeers,
  fetchSelfNode,
  addPeer,
  deletePeer,
  testPeer,
  updatePeer,
  fetchMesh,
  type PeerView,
  type SelfNode,
  type MeshView,
} from '../lib/api';
import { MeshPanel } from '../components/federation/MeshPanel';
import { CoveragePanel } from '../components/federation/CoveragePanel';
import { NodeDetailPanel } from '../components/federation/NodeDetailPanel';
import { LINK_LABEL } from '../components/federation/format';

/** 画面の再取得間隔。 サーバ側はキャッシュを返すだけなので、 ここを縮めても他拠点への通信は増えない。 */
const REFRESH_MS = 15_000;

export default function Federation() {
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [mesh, setMesh] = useState<MeshView | null>(null);
  const [self, setSelf] = useState<SelfNode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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
      const [p, m] = await Promise.all([fetchPeers(), fetchMesh()]);
      setPeers(p);
      setMesh(m);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const reloadMesh = useCallback(async () => {
    const m = await fetchMesh();
    setMesh(m);
  }, []);

  useEffect(() => {
    void reload();
    void fetchSelfNode().then(setSelf).catch(() => {});
    const id = setInterval(() => {
      void fetchMesh().then(setMesh).catch(() => {});
    }, REFRESH_MS);
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

  const selectedNode = mesh?.nodes.find((n) => n.node === (selected ?? mesh.self)) ?? null;
  const linkOfPeer = (peerId: string) => mesh?.nodes.find((n) => n.peer_id === peerId) ?? null;

  return (
    <div className="federation">
      {error && <div className="error-banner">エラー: {error}</div>}

      <SelfNodePanel self={self} />

      <h2 className="mem-section-title">拠点メッシュ</h2>
      <p className="muted">
        各拠点は自分の監視ループで確かめた死活を保存しておき、 ほかの拠点はそれを巡回周期 (既定 60 秒) で
        取りに行きます。 この画面を開いても、 死活の確認も拠点間の通信も増えません。 拠点をクリックすると詳細と依頼。
      </p>
      {mesh === null ? (
        <div className="empty-state">読み込み中…</div>
      ) : (
        <MeshPanel mesh={mesh} selected={selectedNode?.node ?? null} onSelect={setSelected} />
      )}
      {mesh && selectedNode && <NodeDetailPanel mesh={mesh} node={selectedNode} onChanged={reloadMesh} />}

      <h2 className="mem-section-title">担保 (どの拠点がどのサービスを見るか)</h2>
      {mesh === null ? (
        <div className="empty-state">読み込み中…</div>
      ) : (
        <CoveragePanel mesh={mesh} onChanged={reloadMesh} />
      )}

      <h2 className="mem-section-title">他拠点ピア</h2>
      <div className="peer-add foundation-form">
        <input placeholder="拠点名 (例: 自宅PC)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="base_url (例: http://100.x.y.z:17335 — 相手の拠点間リスナー)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input placeholder="agent token" value={token} onChange={(e) => setToken(e.target.value)} type="password" />
        <input placeholder="CF-Access Client Id (任意)" value={cfId} onChange={(e) => setCfId(e.target.value)} />
        <input placeholder="CF-Access Client Secret (任意)" value={cfSecret} onChange={(e) => setCfSecret(e.target.value)} type="password" />
        <button disabled={busy || !name || !baseUrl || !token} onClick={() => void onAdd()}>
          追加
        </button>
      </div>
      <p className="muted">
        疎通には相互登録が要ります: 相手の拠点でもこの拠点を登録するまで「相互登録待ち」になり、 死活の取得も依頼もできません。
        相手ノードが Cloudflare Access の後ろにある場合のみ CF-Access の Service Token を入力 (両方揃えば送信)。 token / secret は暗号化保存。
      </p>

      {peers.length === 0 ? (
        <div className="empty-state">ピア未登録。 相手 Excubitor の拠点間リスナーの URL と agent token を登録し、 相手側でもこの拠点を登録するとつながります。</div>
      ) : (
        <table className="peer-table">
          <thead>
            <tr>
              <th>拠点</th><th>URL</th><th>token</th><th>状態</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {peers.map((p) => {
              const link = linkOfPeer(p.id);
              return (
                <tr key={p.id} className={p.enabled ? '' : 'disabled'}>
                  <td>{p.name}</td>
                  <td className="mono">{p.base_url}</td>
                  <td className="mono">{p.token_hint}{p.cf_access_id ? ' · CF✓' : ''}</td>
                  <td>
                    {link ? <span className={`link-badge link-${link.status}`}>{LINK_LABEL[link.status]}</span> : '—'}
                    {p.last_error && <div className="bad small">{p.last_error}</div>}
                  </td>
                  <td className="peer-actions">
                    <button disabled={busy} onClick={() => void onTest(p.id)}>疎通</button>
                    <button disabled={busy} onClick={() => void onToggle(p)}>{p.enabled ? '無効化' : '有効化'}</button>
                    <button disabled={busy} className="danger" onClick={() => void onDelete(p.id)}>削除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
      <div className="self-node-row">
        <span className="muted">拠点間リスナー:</span>
        {self.listener.enabled ? (
          self.mesh_base_urls.length > 0 ? (
            self.mesh_base_urls.map((url) => <code key={url} className="self-token mono">{url}</code>)
          ) : (
            <span className="bad">bind 待ち (メッシュ側アドレスがまだ無い。 30 秒ごとに再試行)</span>
          )
        ) : self.listener.error ? (
          <span className="bad">設定エラー: {self.listener.error}</span>
        ) : (
          <span className="muted">無効 (EXCUBITOR_FEDERATION_LISTEN 未設定。 他拠点からは届きません)</span>
        )}
      </div>
      <p className="self-node-hint muted">
        この token と拠点間リスナーの URL を相手ノードの「他拠点ピア」登録に貼り、 こちらでも相手を登録すると
        つながります (相互登録。 Tailscale / Cloudflare Mesh の中だけで通信します)。
      </p>
    </section>
  );
}
