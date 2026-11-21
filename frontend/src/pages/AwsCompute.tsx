import { useEffect, useState } from 'react';
import { listJobs, listTargets, readSweep, stopJob, type ComputeJob } from '../aws-compute/api';
import { TargetSettings } from '../aws-compute/TargetSettings';

const releaseLabel: Record<ComputeJob['release'], string> = {
  pending: '未解放', requested: '停止要求済み', confirmed: '解放確認済み', not_allocated: '割り当てなし',
};

export default function AwsCompute() {
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof listTargets>> | null>(null);
  const [jobs, setJobs] = useState<ComputeJob[]>([]);
  const [sweep, setSweep] = useState<Awaited<ReturnType<typeof readSweep>>['sweep']>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [stopError, setStopError] = useState('');
  const [stopping, setStopping] = useState<string | null>(null);
  const refresh = () => setRefreshKey((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load(initial: boolean) {
      if (pending) return;
      pending = true;
      try {
        const signal = controller.signal;
        const [jobData, sweepData, targetData] = await Promise.all([
          listJobs(signal, !showHistory), readSweep(signal), initial ? listTargets(signal) : undefined,
        ]);
        if (signal.aborted) return;
        setJobs(jobData.jobs);
        setSweep(sweepData.sweep);
        if (targetData) setTargets(targetData);
        setLoadError('');
      } catch (failure) {
        if (!controller.signal.aborted) setLoadError((failure as Error).message);
      } finally {
        pending = false;
      }
    }
    void load(true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [refreshKey, showHistory]);

  async function stop(job: ComputeJob) {
    if (!window.confirm(`ジョブ「${job.job_id}」を停止しますか？`)) return;
    setStopping(job.operation_id);
    setStopError('');
    try {
      const receipt = await stopJob(job.operation_id);
      setJobs((current) => current.map((item) => item.operation_id === receipt.operation_id ? receipt : item));
      refresh();
    } catch (failure) {
      setStopError((failure as Error).message);
    } finally {
      setStopping(null);
    }
  }

  return (
    <div>
      <h1>AWS 計算ジョブ</h1>
      {loadError && <p role="alert">{loadError === 'loopback_required' ? 'Excubitor を実行している端末から開いてください。' : loadError}</p>}
      <section>
        <h2>ジョブ</h2>
        <label><input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} /> 履歴も表示</label>{' '}
        <button onClick={refresh}>更新</button>
        {stopError && <p role="alert">{stopError}</p>}
        {jobs.length === 0 ? <p>表示するジョブはありません。</p> : (
          <table className="data-table">
            <thead><tr><th>ジョブ</th><th>実行先</th><th>状態</th><th>期限</th><th>解放</th><th>操作</th></tr></thead>
            <tbody>{jobs.map((job) => (
              <tr key={job.operation_id}>
                <td>{job.job_id}</td><td>{job.target_id}</td>
                <td>{job.provider_state ?? job.submission}
                  {job.issue && <div>{job.issue}</div>}
                  {job.containers.filter((item) => item.exit_code !== null).map((item) => (
                    <div key={item.name}>{item.name} ({item.exit_code})</div>
                  ))}
                </td>
                <td>{new Date(job.deadline).toLocaleString()}</td><td>{releaseLabel[job.release]}</td>
                <td>{job.release === 'pending' && <button disabled={stopping !== null} onClick={() => void stop(job)}>停止</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {sweep && (
        <section>
          <h2>棚卸し</h2>
          <p>{new Date(sweep.completed_at).toLocaleString()} · 期限切れ {sweep.expired} 件 · 照会・停止エラー {sweep.errors} 件</p>
          {sweep.resources.length > 0 && <ul>{sweep.resources.map((resource) => (
            <li key={resource.resource_id}>{resource.target_id} · {resource.resource_id} · {resource.action}</li>
          ))}</ul>}
        </section>
      )}
      <TargetSettings targets={targets?.targets ?? []} configured={targets?.credentials.configured ?? null} refresh={refresh} />
    </div>
  );
}
