import { useState, type FormEvent } from 'react';
import { deleteTarget, saveTarget, type ComputeTarget } from './api';

const common = {
  id: '', name: '', region: 'ap-northeast-1', maxRuntimeSeconds: 3600, orphanPolicy: 'report',
};
const template = {
  ec2: {
    ...common, kind: 'ec2', image: { kind: 'ami', id: '' }, instanceType: '', subnet: '', securityGroup: '',
    runners: [{ id: '', executable: '/opt/excubitor/run-job', args: [], inputKeys: [] }],
  },
  fargate: {
    ...common, kind: 'fargate', cluster: '', taskDefinition: '', subnets: [''], securityGroups: [''], assignPublicIp: false,
    runners: [{ id: '', container: '', inputKeys: [] }],
  },
};

export function TargetSettings({ targets, configured, refresh }: {
  targets: ComputeTarget[];
  configured: boolean | null;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function edit(target: unknown, id: string | null) {
    setEditing(id);
    setDraft(JSON.stringify(target, null, 2));
    setError('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const input = JSON.parse(draft) as { id?: unknown } | null;
      if (typeof input?.id !== 'string' || !input.id || (editing && editing !== input.id)) {
        throw new Error('実行先 ID を入力してください。登録済みの ID は変更できません。');
      }
      if (!editing && targets.some((target) => target.id === input.id)) {
        throw new Error('同じ実行先 ID が既に登録されています。編集から変更してください。');
      }
      await saveTarget(input.id, input);
      setDraft('');
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: ComputeTarget) {
    if (!window.confirm(`「${target.name}」を登録から削除しますか？`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteTarget(target.id);
      if (editing === target.id) setDraft('');
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>実行先設定</h2>
      <p>Vault 資格情報 {configured === null ? '未確認' : configured ? '設定済み' : '未設定'} · <a href="#env">環境変数を開く</a></p>
      <p><button disabled={busy} onClick={() => edit(template.ec2, null)}>EC2 を登録</button>{' '}
        <button disabled={busy} onClick={() => edit(template.fargate, null)}>Fargate を登録</button></p>
      {targets.length > 0 && (
        <table className="data-table">
          <thead><tr><th>名前</th><th>種類</th><th>リージョン</th><th>上限（秒）</th><th>操作</th></tr></thead>
          <tbody>{targets.map((target) => (
            <tr key={target.id}>
              <td>{target.name} ({target.id})</td><td>{target.kind}</td><td>{target.region}</td><td>{target.maxRuntimeSeconds}</td>
              <td><button disabled={busy} onClick={() => edit(target, target.id)}>編集</button>{' '}
                <button disabled={busy} onClick={() => void remove(target)}>削除</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {error && <p role="alert">{error}</p>}
      {draft && (
        <form onSubmit={(event) => void save(event)}>
          <label htmlFor="aws-compute-target">実行先設定（JSON）</label>
          <textarea id="aws-compute-target" rows={17} value={draft} onChange={(event) => setDraft(event.target.value)}
            spellCheck={false} disabled={busy} style={{ display: 'block', width: '100%', maxWidth: '56rem', fontFamily: 'monospace' }} />
          <button type="submit" disabled={busy}>保存</button>{' '}
          <button type="button" disabled={busy} onClick={() => { setDraft(''); setError(''); }}>閉じる</button>
        </form>
      )}
    </section>
  );
}
