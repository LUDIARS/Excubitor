import { useMemo, useState } from 'react';
import { setCoverage, type CoverageIssue, type MeshCoverageEntry, type MeshView } from '../../lib/api';
import { fmtAgo, HEALTH_LABEL } from './format';
import { useServiceInstall } from './useServiceInstall';
import { installationBlock } from './install-policy';
import { OperationTracker } from './OperationTracker';

/**
 * @implements SPEC-FEDERATION-COVERAGE
 * @implements SPEC-SERVICE-INSTALL-CANDIDATES
 */

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
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [serversOnly, setServersOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = mesh.nodes.map((n) => n.node);
  const installation = useServiceInstall(onChanged);
  const rows = useMemo(
    () => mesh.coverage.filter(row => {
      if (serversOnly && row.server_install_candidate !== true) return false;
      if (issuesOnly && row.issues.length === 0) return false;
      return [row.name, row.code, row.project_code, row.repository].join(' ').toLowerCase().includes(query.trim().toLowerCase());
    }),
    [issuesOnly, serversOnly, query, mesh.coverage],
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
        <label><input type="checkbox" checked={serversOnly} onChange={e => setServersOnly(e.target.checked)} />サーバー向けサービスだけ</label>
        <input aria-label="サービスを検索" placeholder="名前・コード・リポジトリで検索" value={query} onChange={e => setQuery(e.target.value)} />
        <label>
          <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />
          指摘のあるサービスだけ
        </label>
        <span className="muted">表示 {rows.length} 件 / 全 {mesh.coverage.length} 件 / 指摘 {mesh.coverage.filter((r) => r.issues.length > 0).length} 件</span>
      </div>
      <p className="muted small">この拠点のカタログから設置先を選びます。導入時に各サービスのセットアップ定義を確認します。</p>
      {error && <div className="error-banner">担保の変更に失敗: {error}</div>}
      {installation.error && <div className="error-banner">{installation.error}</div>}
      {installation.tracked && <div>
        <strong>{installation.tracked.node} へのインストール</strong>
        <OperationTracker key={installation.tracked.id} peerId={installation.tracked.peerId}
          operationId={installation.tracked.id} onDone={installation.onDone} />
      </div>}
      {rows.length === 0 ? (
        <div className="empty-state">条件に一致するサービスがありません。検索や絞り込みを変更してください。</div>
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
                    {mesh.nodes.map((node) => (
                      <td key={node.node}>
                        {!byNode.has(node.node) ? <button type="button" className="btn btn-sm"
                          disabled={installation.busy || installationBlock(row, node) !== null}
                          title={installationBlock(row, node) ?? (node.node + ' に取得・セットアップ・起動')}
                          onClick={() => void installation.install(row, node)}>
                          インストール
                        </button> :
                        <CoverageCell
                          entry={byNode.get(node.node)}
                          editable={node.node === mesh.self}
                          busy={busy === row.code}
                          onOverride={(value) => void onOverride(row.code, value)}
                        />}
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
