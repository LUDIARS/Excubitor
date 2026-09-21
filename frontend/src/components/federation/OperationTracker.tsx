import { useEffect, useState } from 'react';
import { fetchOperation, type OperationDetail } from '../../lib/api';
import { OPERATION_LABEL, OPERATION_STATUS_LABEL } from './format';

/** @implements SPEC-FEDERATION-OPERATIONS */

/** 依頼の状態を見ている間だけ取りに行く間隔。 終わったら止める。 */
const POLL_MS = 3_000;

function isDone(op: OperationDetail | null): boolean {
  return op !== null && (op.status === 'succeeded' || op.status === 'failed');
}

/**
 * 出したばかりの依頼を追う。 実行中は依頼先に状態を聞き続け、 終わったら手順を並べて止まる。
 * Excubitor 自身の再起動中は相手の応答が途切れるので、 取得の失敗は表示だけして聞き続ける。
 */
export function OperationTracker({ peerId, operationId, onDone }: {
  peerId: string | null;
  operationId: string;
  onDone: () => void;
}) {
  const [op, setOp] = useState<OperationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await fetchOperation(peerId, operationId);
        if (cancelled) return;
        setOp(next);
        setError(null);
        if (isDone(next)) {
          onDone();
          return;
        }
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [peerId, operationId, onDone]);

  if (!op) return <div className="muted small">依頼の状態を取得中… {error && <span className="bad">{error}</span>}</div>;
  return (
    <div className={`op-tracker op-${op.status}`}>
      <div>
        <strong>{OPERATION_LABEL[op.action]}</strong>{' '}
        <span className="mono">{op.target.kind === 'excubitor' ? 'Excubitor' : op.target.code}</span>{' '}
        <span className={`op-status op-status-${op.status}`}>{OPERATION_STATUS_LABEL[op.status]}</span>
        {error && <span className="muted small"> (応答待ち: {error})</span>}
      </div>
      {op.error && <div className="bad small">{op.error}</div>}
      <ol className="op-steps">
        {op.steps.map((s, i) => (
          <li key={`${s.step}-${i}`} className={s.ok ? 'ok' : 'bad'}>
            <span className="mono">{s.step}</span> {s.detail && <span className="muted small">{s.detail.slice(0, 300)}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
