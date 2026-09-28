import type { MeshCoverageRow, MeshNode } from '../../lib/api';

/**
 * @implements SPEC-SERVICE-BOOTSTRAP
 * @implements SPEC-SERVICE-INSTALL-CANDIDATES
 */
export function installationBlock(row: MeshCoverageRow, node: MeshNode): string | null {
  if (row.server_install_candidate !== true) return 'PC専用サービス・ローカルアプリ・ゲーム、またはサービス種別が未確認です';
  if (node.status !== 'up' || node.stale || (!node.is_self && !node.peer_id)) return '拠点の接続と最新情報を確認できません';
  if (row.nodes.some(entry => entry.node === node.node)) return 'この拠点には登録済みです';
  if (!row.repository || !/^LUDIARS\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(row.repository)) return '取得元が未登録、または拠点間で一致していません';
  if (/^LUDIARS\/(Excubitor|Castra)$/i.test(row.repository)) return 'このリポジトリはサービス導入の対象外です';
  if (node.node_info?.update_source === 'mesh') return 'この拠点はGitHubからの導入を利用できません';
  if (node.operations.some(op => op.target.kind === 'service' && op.target.code === row.code &&
    !['succeeded', 'failed'].includes(op.status))) return 'このサービスの操作が進行中です';
  return null;
}

