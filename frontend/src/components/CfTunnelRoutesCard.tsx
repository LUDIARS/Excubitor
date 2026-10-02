import { useState } from 'react';
import {
  fetchCfTunnelRoutes,
  removeCfAccessApp,
  removeCfTunnel,
  removeCfTunnelDns,
  removeCfTunnelRoute,
  type CfTunnelRoute,
  type CfTunnelRoutes,
} from '../lib/api';

const BUSY_KEY = 'cf-tunnel-routes';

interface Props {
  /** Config ページ全体で共有する進行中フラグ (同時操作を避けるため受け取る)。 */
  busy: string | null;
  setBusy: (value: string | null) => void;
}

interface Result {
  ok: boolean;
  message: string;
}

const routeKey = (r: CfTunnelRoute) => `${r.hostname ?? ''}\u0000${r.path ?? ''}`;

/**
 * CF Tunnel のルート一覧と削除 (route → tunnel 向き CNAME → Access アプリ)、Tunnel 自体の削除。
 * 削除は 2 段階 (押す → 「削除を実行」) にして誤操作を防ぐ。Tunnel 削除は名前の打ち込みが要る。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export default function CfTunnelRoutesCard({ busy, setBusy }: Props) {
  const [tunnelInput, setTunnelInput] = useState('');
  const [data, setData] = useState<CfTunnelRoutes | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [alsoDns, setAlsoDns] = useState(true);
  // Access アプリが無い hostname で選ぶと 400 になるため既定は外す。
  const [alsoAccess, setAlsoAccess] = useState(false);
  const [accessService, setAccessService] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const run = async (task: () => Promise<string>) => {
    setBusy(BUSY_KEY);
    setResult(null);
    try {
      setResult({ ok: true, message: await task() });
    } catch (err) {
      // 失敗理由 (allowlist 外・別向きのレコード等) を必ず出す。途中までの成功は message に残す。
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const load = () => run(async () => {
    const next = await fetchCfTunnelRoutes(tunnelInput);
    setData(next);
    setPending(null);
    return `${next.tunnel.name}: ${next.routes.filter((r) => r.hostname).length} routes`;
  });

  const removeRoute = (route: CfTunnelRoute) => run(async () => {
    const tunnel = data?.tunnel.id ?? tunnelInput;
    const hostname = route.hostname!;
    const done: string[] = [];
    try {
      await removeCfTunnelRoute({ tunnel, hostname, path: route.path });
      done.push('route');
      if (alsoDns) {
        const dns = await removeCfTunnelDns({ tunnel, hostname });
        done.push(dns.removed ? 'DNS' : 'DNS (無し)');
      }
      if (alsoAccess) {
        await removeCfAccessApp({ hostname, service: accessService });
        done.push(accessService.trim() ? 'Access + runtime-config' : 'Access');
      }
    } catch (err) {
      throw new Error(`${done.length ? `削除済み: ${done.join(', ')} / ` : ''}${(err as Error).message}`);
    } finally {
      setPending(null);
      setData(await fetchCfTunnelRoutes(tunnel).catch(() => data));
    }
    return `${hostname}${route.path ? ` ${route.path}` : ''} を削除: ${done.join(', ')}`;
  });

  const removeTunnel = () => run(async () => {
    if (!data) throw new Error('先に一覧を読み込む');
    const removed = await removeCfTunnel({ tunnel: data.tunnel.id, confirm: confirmName });
    setData(null);
    setConfirmName('');
    return `Tunnel ${removed.tunnel.name} を削除しました`;
  });

  const routed = data?.routes.filter((r) => r.hostname) ?? [];
  const disabled = busy !== null;

  return (
    <section className="config-card">
      <h2>CF Tunnel routes</h2>
      <p className="muted">
        Tunnel の public hostname ルート。allowlist にある hostname だけ削除できる。DNS は tunnel を向いた
        CNAME だけ、Access アプリは domain が完全一致するものだけを消す。
      </p>
      <div className="config-form">
        <label>
          Tunnel (id か name。アカウントに 1 本だけなら空でよい)
          <input value={tunnelInput} onChange={(e) => setTunnelInput(e.target.value)} placeholder="ludiars-local" />
        </label>
        <div className="config-actions">
          <button disabled={disabled} onClick={() => void load()}>
            {busy === BUSY_KEY ? 'Working...' : 'Load routes'}
          </button>
        </div>
      </div>

      {data && (
        <>
          <p className="muted small">
            Tunnel <code>{data.tunnel.name}</code> / allowlist: {data.allowed_hostnames.join(', ') || '(なし: 削除不可)'}
          </p>
          <div className="config-form">
            <label><input type="checkbox" checked={alsoDns} onChange={(e) => setAlsoDns(e.target.checked)} /> DNS (CNAME) も消す</label>
            <label><input type="checkbox" checked={alsoAccess} onChange={(e) => setAlsoAccess(e.target.checked)} /> Access アプリも消す</label>
            {alsoAccess && (
              <label>
                runtime-config から Access 設定を外すサービス (任意)
                <input value={accessService} onChange={(e) => setAccessService(e.target.value)} placeholder="quaestor" />
              </label>
            )}
          </div>
          <table className="config-table">
            <thead>
              <tr><th>hostname</th><th>path</th><th>service</th><th>Access</th><th /></tr>
            </thead>
            <tbody>
              {data.routes.map((route) => (
                <tr key={routeKey(route)}>
                  <td>{route.hostname ?? <span className="muted">(catch-all)</span>}</td>
                  <td>{route.path ?? ''}</td>
                  <td><code>{route.service}</code></td>
                  <td>{route.access_required ? 'required' : ''}</td>
                  <td>
                    {route.mutable && pending !== routeKey(route) && (
                      <button disabled={disabled} onClick={() => setPending(routeKey(route))}>Delete</button>
                    )}
                    {route.mutable && pending === routeKey(route) && (
                      <>
                        <button className="danger" disabled={disabled} onClick={() => void removeRoute(route)}>削除を実行</button>{' '}
                        <button disabled={disabled} onClick={() => setPending(null)}>やめる</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Tunnel を削除</h3>
          <p className="muted small">
            hostname 付きのルートが 0 件で、cloudflared が接続していないときだけ消せる。確認のため tunnel 名
            <code>{data.tunnel.name}</code> を入力する。
          </p>
          <div className="config-form">
            <label>
              Tunnel 名
              <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={data.tunnel.name} />
            </label>
            <div className="config-actions">
              <button
                className="danger"
                disabled={disabled || routed.length > 0 || confirmName.trim() !== data.tunnel.name}
                onClick={() => void removeTunnel()}
              >
                Delete tunnel
              </button>
            </div>
            {routed.length > 0 && <p className="muted small">ルートが {routed.length} 件残っているため削除できない</p>}
          </div>
        </>
      )}

      {result && (
        <p className={`muted small ${result.ok ? 'ok' : 'fail'}`}>
          {result.ok ? '✓' : '✗'} {result.message}
        </p>
      )}
    </section>
  );
}
