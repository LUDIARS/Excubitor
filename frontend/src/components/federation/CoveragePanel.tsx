import { useMemo, useState } from 'react';
import { setCoverage, type CoverageIssue, type MeshCoverageEntry, type MeshView } from '../../lib/api';
import { fmtAgo, HEALTH_LABEL } from './format';

const ISSUE_LABEL: Record<CoverageIssue, string> = {
  duplicate_managed: '複数拠点が管理',
  uncovered: '担保なし',
  down: '停止',
};

/**
 * サービス × 拠点の担保表。 各セルは「その拠点が担保しているか (管理 / 観測のみ)」と、
 * その拠点がキャッシュしている死活。 この拠点の列だけは担保の上書きができる。
 */
export function CoveragePanel({ mesh, onChanged }: { mesh: MeshView; onChanged: () => Promise<void> }) {
  const hasIssues = mesh.coverage.some((row) => row.issues.length > 0);
  const [issuesOnly, setIssuesOnly] = useState(hasIssues);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = mesh.nodes.map((n) => n.node);
  const rows = useMemo(
    () => (issuesOnly ? mesh.coverage.filter((row) => row.issues.length > 0) : mesh.coverage),
    [issuesOnly, mesh.coverage],
  );

  const onOverride = async (code: string, value: string) => {
    setBusy(code);
    try {
      await setCoverage(code, value === 'default' ? null : value === 'on');
      setError(null);
      await onChanged();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="coverage-panel">
      <div className="coverage-toolbar">
        <label>
          <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />
          指摘のあるサービスだけ
        </label>
        <span className="muted">全 {mesh.coverage.length} 件 / 指摘 {mesh.coverage.filter((r) => r.issues.length > 0).length} 件</span>
      </div>
      {error && <div className="error-banner">担保の変更に失敗: {error}</div>}
      {rows.length === 0 ? (
        <div className="empty-state">{issuesOnly ? '指摘のあるサービスはありません。' : 'サービスがありません。'}</div>
      ) : (
        <div className="mesh-matrix-wrap">
          <table className="peer-table coverage-table">
            <thead>
              <tr>
                <th>サービス</th>
                {names.map((name) => <th key={name}>{name}</th>)}
                <th>指摘</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const byNode = new Map(row.nodes.map((entry) => [entry.node, entry]));
                return (
                  <tr key={row.code}>
                    <td>
                      <div>{row.name}</div>
                      <div className="mono muted small">{row.code}</div>
                    </td>
                    {names.map((name) => (
                      <td key={name}>
                        <CoverageCell
                          entry={byNode.get(name)}
                          editable={name === mesh.self}
                          busy={busy === row.code}
                          onOverride={(value) => void onOverride(row.code, value)}
                        />
                      </td>
                    ))}
                    <td>
                      {row.issues.map((issue) => (
                        <span key={issue} className={`issue-badge issue-${issue}`}>{ISSUE_LABEL[issue]}</span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CoverageCell({
  entry,
  editable,
  busy,
  onOverride,
}: {
  entry: MeshCoverageEntry | undefined;
  editable: boolean;
  busy: boolean;
  onOverride: (value: string) => void;
}) {
  if (!entry) return <span className="muted" title="この拠点の catalog に載っていない">—</span>;
  const selectValue = entry.source === 'override' ? (entry.covered ? 'on' : 'off') : 'default';
  return (
    <div className={`coverage-cell${entry.stale ? ' stale' : ''}`}>
      {entry.covered ? (
        <>
          <span className={`health-dot health-${entry.health}`} title={`${HEALTH_LABEL[entry.health]} · ${fmtAgo(entry.checked_at)}`} />
          <span>{entry.kind === 'managed' ? '管理' : '観測のみ'}</span>
          <span className="muted small"> {HEALTH_LABEL[entry.health]}</span>
        </>
      ) : (
        <span className="muted">担保しない</span>
      )}
      {editable && (
        <select
          className="coverage-override"
          value={selectValue}
          disabled={busy}
          onChange={(e) => onOverride(e.target.value)}
          title="この拠点での担保を上書き (既定 = catalog に載っていれば担保)"
        >
          <option value="default">既定</option>
          <option value="on">担保する</option>
          <option value="off">担保しない</option>
        </select>
      )}
    </div>
  );
}
