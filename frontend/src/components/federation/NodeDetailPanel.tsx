import { useCallback, useState } from 'react';
import {
  requestOperation,
  type MeshNode,
  type MeshView,
  type OperationAction,
  type OperationTarget,
} from '../../lib/api';
import { fmtAgo, fmtTime, LINK_LABEL, OPERATION_LABEL, OPERATION_STATUS_LABEL } from './format';
import { OperationTracker } from './OperationTracker';

/** @implements SPEC-FEDERATION-NODE-INFO */

function fmtGiB(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return '—';
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

const SELF_ACTIONS: OperationAction[] = ['update', 'deploy', 'reflect', 'restart'];
const SERVICE_ACTIONS: OperationAction[] = ['update', 'deploy', 'reflect', 'restart', 'start', 'stop'];
/** 止めたり入れ替えたりする依頼は確認を挟む。 */
const CONFIRM_ACTIONS: ReadonlySet<OperationAction> = new Set(['deploy', 'restart', 'stop']);

/**
 * 1 拠点の詳細: 拠点情報・担保しているサービス・依頼の履歴と、 その拠点への依頼ボタン。
 * 自拠点なら自分への依頼、 他拠点なら相手への依頼 (相互登録済みのときだけ届く)。
 */
export function NodeDetailPanel({ mesh, node, onChanged }: {
  mesh: MeshView;
  node: MeshNode;
  onChanged: () => Promise<void>;
}) {
  const [tracked, setTracked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const peerId = node.is_self ? null : node.peer_id;
  const info = node.node_info;
  const reachable = node.is_self || node.status === 'up';

  const services = mesh.coverage
    .map((row) => ({ row, entry: row.nodes.find((n) => n.node === node.node) }))
    .filter(({ entry }) => entry?.covered);

  const onRequest = async (target: OperationTarget, action: OperationAction) => {
    const label = `${node.node} の ${target.kind === 'excubitor' ? 'Excubitor' : target.code} を${OPERATION_LABEL[action]}`;
    if (CONFIRM_ACTIONS.has(action) && !window.confirm(`${label}します。よろしいですか？`)) return;
    setBusy(true);
    try {
      const res = await requestOperation(peerId, target, action);
      setTracked(res.operation.id);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onTrackedDone = useCallback(() => void onChanged(), [onChanged]);

  return (
    <section className="node-detail">
      <div className="node-detail-head">
        <h3>{node.node}{node.is_self && <span className="muted"> (この拠点)</span>}</h3>
        <span className={`link-badge link-${node.status}`}>{LINK_LABEL[node.status]}</span>
        {node.stale && !node.is_self && <span className="muted"> 古い値 ({fmtAgo(node.checked_at)})</span>}
      </div>

      {info ? (
        <dl className="node-info-grid">
          <dt>Excubitor</dt>
          <dd className="mono">{info.excubitor.version} · {info.excubitor.git_branch ?? '—'}@{info.excubitor.git_hash ?? '—'}</dd>
          <dt>起動</dt><dd>{fmtTime(info.excubitor.started_at)} ({fmtAgo(info.excubitor.started_at)})</dd>
          <dt>OS</dt><dd className="mono">{info.platform.os} {info.platform.release} / {info.platform.arch} / {info.platform.hostname}</dd>
          <dt>Node.js</dt><dd className="mono">{info.platform.node_version}</dd>
          <dt>拠点間リスナー</dt>
          <dd className="mono">{info.listener.enabled ? (info.listener.listening.join(', ') || 'bind 待ち') : (info.listener.error ?? '無効')}</dd>
          <dt>ピア</dt><dd>登録 {info.peers.registered} (有効 {info.peers.enabled})</dd>
          <dt>担保</dt><dd>{info.services.covered} / {info.services.catalog_total} (管理 {info.services.managed})</dd>
          <dt>マシン</dt>
          <dd>{node.host ? `CPU ${node.host.cpu_pct != null ? `${node.host.cpu_pct}%` : '—'} · メモリ ${fmtGiB(node.host.used_mem_bytes)} / ${fmtGiB(node.host.totalMemBytes)}` : '—'}</dd>
          <dt>更新の取得元</dt><dd>{info.update_source === 'mesh' ? '依頼元拠点 (mesh)' : info.update_source === 'origin' ? 'git remote (origin)' : <span className="bad">設定不正</span>}</dd>
        </dl>
      ) : (
        <div className="empty-state">拠点情報をまだ受け取っていません{node.error ? ` (${node.error})` : ''}。</div>
      )}

      {error && <div className="error-banner">依頼に失敗: {error}</div>}
      {tracked && <OperationTracker peerId={peerId} operationId={tracked} onDone={onTrackedDone} />}

      <div className="node-ops">
        <span className="muted">Excubitor 自身:</span>
        {SELF_ACTIONS.map((action) => (
          <button key={action} disabled={busy || !reachable} onClick={() => void onRequest({ kind: 'excubitor' }, action)}>
            {OPERATION_LABEL[action]}
          </button>
        ))}
        {!reachable && <span className="muted small">つながっていないため依頼できません</span>}
      </div>

      <table className="peer-table node-services">
        <thead>
          <tr><th>サービス</th><th>死活</th><th>依頼</th></tr>
        </thead>
        <tbody>
          {services.map(({ row, entry }) => (
            <tr key={row.code}>
              <td>{row.name} <span className="mono muted small">{row.code}</span></td>
              <td><span className={`health-dot health-${entry!.health}`} /> {entry!.kind === 'managed' ? '管理' : '観測のみ'}</td>
              <td className="peer-actions">
                {entry!.kind === 'managed'
                  ? SERVICE_ACTIONS.map((action) => (
                    <button key={action} disabled={busy || !reachable} onClick={() => void onRequest({ kind: 'service', code: row.code }, action)}>
                      {OPERATION_LABEL[action]}
                    </button>
                  ))
                  : <span className="muted small">起動定義が無いため依頼できません</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className="mesh-subtitle">依頼の履歴</h4>
      {node.operations.length === 0 ? (
        <div className="empty-state">依頼はまだありません。</div>
      ) : (
        <table className="peer-table op-history">
          <thead>
            <tr><th>受付</th><th>依頼元</th><th>対象</th><th>内容</th><th>状態</th><th>最後の手順</th></tr>
          </thead>
          <tbody>
            {node.operations.map((op) => (
              <tr key={op.id}>
                <td>{fmtTime(op.created_at)}</td>
                <td>{op.requested_by}</td>
                <td className="mono">{op.target.kind === 'excubitor' ? 'Excubitor' : op.target.code}</td>
                <td>{OPERATION_LABEL[op.action]}{op.source === 'mesh' && <span className="muted small"> (mesh)</span>}</td>
                <td className={`op-status op-status-${op.status}`}>{OPERATION_STATUS_LABEL[op.status]}</td>
                <td className="small">{op.error ?? op.last_step ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
