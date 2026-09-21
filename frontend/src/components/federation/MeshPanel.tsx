import type { MeshLink, MeshView } from '../../lib/api';
import { fmtAgo, LINK_LABEL } from './format';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

/**
 * 拠点メッシュの到達性。 上段が拠点ごとの状態、 下段が拠点 → 拠点のつながり表。
 * メッシュなので A→B と B→A は別々に出す (片方向だけ切れていることがある)。
 */
export function MeshPanel({ mesh, selected, onSelect }: {
  mesh: MeshView;
  /** 選択中の拠点名 (詳細パネルに出す)。 */
  selected: string | null;
  onSelect: (node: string) => void;
}) {
  const names = mesh.nodes.map((n) => n.node);
  const linkOf = new Map<string, MeshLink>();
  for (const link of mesh.links) linkOf.set(`${link.from}\u0000${link.node}`, link);

  return (
    <section className="mesh-panel">
      <table className="peer-table mesh-nodes">
        <thead>
          <tr>
            <th>拠点</th><th>状態</th><th>応答</th><th>最終確認</th><th>担保</th><th>監視の最終周</th>
          </tr>
        </thead>
        <tbody>
          {mesh.nodes.map((n) => (
            <tr
              key={n.peer_id ?? `self:${n.node}`}
              className={`mesh-node-row${n.stale ? ' stale' : ''}${selected === n.node ? ' selected' : ''}`}
              onClick={() => onSelect(n.node)}
              title="クリックで拠点の詳細"
            >
              <td>
                {n.node}
                {n.is_self && <span className="muted"> (この拠点)</span>}
              </td>
              <td>
                <span className={`link-badge link-${n.status}`}>{LINK_LABEL[n.status]}</span>
                {n.stale && !n.is_self && <span className="muted"> 古い値</span>}
                {n.error && <div className="bad small">{n.error}</div>}
              </td>
              <td className="mono">{n.latency_ms != null ? `${n.latency_ms}ms` : '—'}</td>
              <td>{fmtAgo(n.checked_at)}</td>
              <td>
                {n.covered_total} / {n.services_total}
                {n.covered_down > 0 && <span className="bad"> · 停止 {n.covered_down}</span>}
              </td>
              <td>{fmtAgo(n.scan_completed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {names.length > 1 && (
        <>
          <h3 className="mesh-subtitle">拠点間のつながり (行 → 列)</h3>
          <div className="mesh-matrix-wrap">
            <table className="mesh-matrix">
              <thead>
                <tr>
                  <th />
                  {names.map((to) => <th key={to}>{to}</th>)}
                </tr>
              </thead>
              <tbody>
                {names.map((from) => (
                  <tr key={from}>
                    <th>{from}</th>
                    {names.map((to) => {
                      if (from === to) return <td key={to} className="muted">—</td>;
                      const link = linkOf.get(`${from}\u0000${to}`);
                      if (!link) return <td key={to} className="muted" title="この拠点はピア登録していないか、 報告が届いていない">未登録</td>;
                      return (
                        <td
                          key={to}
                          className={`link-${link.status}${link.stale ? ' stale' : ''}`}
                          title={link.error ?? `最終確認 ${fmtAgo(link.checked_at)} (報告: ${link.reported_by})`}
                        >
                          {LINK_LABEL[link.status]}
                          {link.latency_ms != null && <span className="mono small"> {link.latency_ms}ms</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
