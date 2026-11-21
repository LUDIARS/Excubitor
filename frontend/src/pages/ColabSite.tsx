import { useEffect, useState } from 'react';

const API = '/api/v1/colab/site';
type Job = { id: string; programId: string; gpu: string; phase: string; deadlineAt: number; stopReason: string | null };
type Site = { enabled: boolean; ready: boolean; job: Job | null };

const phaseLabels: Record<string, string> = {
  accepted: '受付済み', allocating: '割当中', executing: '実行中', collecting: '回収中',
  releasing: '解放中', release_unknown: '解放未確認',
};

async function siteRequest<T>(path: string, signal?: AbortSignal, method = 'GET'): Promise<T> {
  const response = await fetch(API + path, { method, signal, cache: 'no-store' });
  if (!response.ok) throw new Error('colab_request_failed');
  return response.json() as Promise<T>;
}

export default function ColabSite() {
  const [site, setSite] = useState<Site | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setSite(await siteRequest<Site>('', controller.signal));
        setLoadError(false);
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void refresh(), 3000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const act = async (path: string, error: string) => {
    setPending(true);
    setActionError('');
    try {
      await siteRequest(path, AbortSignal.timeout(20_000), 'POST');
      setSite(await siteRequest<Site>('', AbortSignal.timeout(5000)));
    } catch {
      setActionError(error);
    } finally {
      setPending(false);
    }
  };

  const job = site?.job;
  return (
    <section className="card">
      <h2>Colab 拠点</h2>
      {loadError ? <p role="status">拠点の状態を取得できません。</p> : (
        <p role="status">{!site ? '状態を確認中' : !site.enabled ? '無効' : site.ready ? '接続確認済み' : '接続未確認'}</p>
      )}
      {site?.enabled && <button type="button" disabled={pending}
        onClick={() => void act('/readiness', '接続確認に失敗しました。')}>接続を確認</button>}
      {site && !job && <p>実行中のジョブはありません。</p>}
      {job && <>
        <p>{job.programId} · {job.gpu} · {phaseLabels[job.phase] ?? job.phase}</p>
        <p>実行期限 {new Date(job.deadlineAt).toLocaleString()}</p>
        {job.stopReason && <p>停止要求済み</p>}
        <button type="button" disabled={pending || (job.stopReason !== null && job.phase !== 'release_unknown')}
          onClick={() => void act(`/jobs/${job.id}/cancel`, '停止要求に失敗しました。')}>停止</button>
      </>}
      {actionError && <p role="alert">{actionError}</p>}
    </section>
  );
}
