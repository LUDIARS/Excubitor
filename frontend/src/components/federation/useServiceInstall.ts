import { useCallback, useRef, useState } from 'react';
import { requestOperation, type MeshCoverageRow, type MeshNode } from '../../lib/api';

import { installationBlock } from './install-policy';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export function useServiceInstall(onChanged: () => Promise<void>) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<{ id: string; peerId: string | null; node: string } | null>(null);
  const onDone = useCallback(() => {
    locked.current = false;
    setBusy(false);
    void onChanged().catch((e: unknown) => setError('一覧の再取得に失敗: ' + String(e)));
  }, [onChanged]);
  const install = async (row: MeshCoverageRow, node: MeshNode) => {
    if (locked.current || installationBlock(row, node) || !row.repository) return;
    if (!window.confirm(node.node + ' に ' + row.name + ' をインストールします。\n' +
      row.repository + ' の取得・セットアップ後に起動します。続けますか？')) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setTracked(null);
    const peerId = node.is_self ? null : node.peer_id;
    try {
      const { operation } = await requestOperation(peerId, { kind: 'service', code: row.code },
        'bootstrap', { repository: row.repository, start: true });
      setTracked({ id: operation.id, peerId, node: node.node });
    } catch (e: unknown) {
      // A lost response can still mean the peer accepted the operation. Never auto-resubmit.
      setError('受付結果を確認できません。拠点の操作履歴を確認してから画面を再読み込みしてください: ' + String(e));
    }
  };
  return { busy, error, tracked, install, onDone };
}
