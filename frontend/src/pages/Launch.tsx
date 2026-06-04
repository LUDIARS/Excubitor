import { useEffect, useMemo, useState } from 'react';
import {
  fetchLaunchPlan,
  saveLaunchProfile,
  runPreflight,
  launchStart,
  launchStop,
  type LaunchPlan,
  type PreflightReport,
  type LaunchResult,
} from '../lib/api';

/** 初回ウィザードで既定 ON にする推奨セット (存在 & startable なものだけ採用)。 */
const RECOMMENDED = [
  'cernere-backend-dev',
  'cernere-frontend-dev',
  'corpus',
  'bibliotheca',
  'aedilis',
  'actio-backend',
  'actio-frontend',
];

function stateBadge(state: string): string {
  if (state === 'running') return 'badge ok';
  if (state === 'unknown') return 'badge';
  return 'badge down';
}

export default function Launch() {
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const p = await fetchLaunchPlan();
    setPlan(p);
    setAutoLaunch(p.profile.auto_launch);
    if (p.profile.configured) {
      setSelected(new Set(p.profile.selection));
    } else {
      // 初回: 推奨セットのうち存在 & startable のものを既定 ON
      const startable = new Set(
        p.projects.flatMap((pr) => pr.services).filter((s) => s.startable).map((s) => s.code),
      );
      setSelected(new Set(RECOMMENDED.filter((c) => startable.has(c))));
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => void fetchLaunchPlan().then(setPlan).catch(() => {}), 5000);
    return () => clearInterval(id);
  }, []);

  const configured = plan?.profile.configured ?? false;
  const selectedCount = selected.size;

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleProject = (codes: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of codes) (on ? next.add(c) : next.delete(c));
      return next;
    });
  };

  const codes = useMemo(() => Array.from(selected), [selected]);

  const doPreflight = async () => {
    setBusy('preflight');
    try {
      setPreflight(await runPreflight(codes));
    } finally {
      setBusy(null);
    }
  };

  const doSaveAndStart = async () => {
    setBusy('start');
    try {
      await saveLaunchProfile(codes, autoLaunch);
      const r = await launchStart(codes);
      setResult(r);
      setPreflight(r.preflight);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const doSaveOnly = async () => {
    setBusy('save');
    try {
      await saveLaunchProfile(codes, autoLaunch);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const doStopAll = async () => {
    setBusy('stop');
    try {
      await launchStop(codes);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!plan) return <div className="launch">読み込み中…</div>;

  return (
    <div className="launch">
      <div className="launch-head">
        <div>
          <h2>{configured ? '起動セット' : 'ようこそ — 起動するサービスを選んでください'}</h2>
          <p className="muted">
            {configured
              ? '次回 Excubitor 起動時にこのセットを自動で立ち上げます。Corpus / Cernere を含めると leaf より先に起動されます。'
              : 'Excubitor が立ち上げるサービスを選びます。決定すると次回からこのセットが自動起動します。'}
          </p>
        </div>
        <div className="launch-actions">
          <label className="auto-launch">
            <input type="checkbox" checked={autoLaunch} onChange={(e) => setAutoLaunch(e.target.checked)} />
            次回自動起動
          </label>
          <button disabled={busy !== null} onClick={() => void doPreflight()}>
            {busy === 'preflight' ? 'チェック中…' : '起動前チェック'}
          </button>
          <button disabled={busy !== null} onClick={() => void doSaveOnly()}>
            保存のみ
          </button>
          <button className="primary" disabled={busy !== null || selectedCount === 0} onClick={() => void doSaveAndStart()}>
            {busy === 'start' ? '起動中…' : `この構成で起動 (${selectedCount})`}
          </button>
          {configured && (
            <button disabled={busy !== null} onClick={() => void doStopAll()}>
              全停止
            </button>
          )}
        </div>
      </div>

      {preflight && <PreflightView report={preflight} />}
      {result && <ResultView result={result} />}

      <div className="launch-grid">
        {plan.projects.map((pr) => {
          const startable = pr.services.filter((s) => s.startable).map((s) => s.code);
          const allOn = startable.length > 0 && startable.every((c) => selected.has(c));
          return (
            <section key={pr.project_code} className="launch-project">
              <header>
                <strong>{pr.project_code}</strong>
                {startable.length > 0 && (
                  <button className="link" onClick={() => toggleProject(startable, !allOn)}>
                    {allOn ? '全解除' : '全選択'}
                  </button>
                )}
              </header>
              {pr.services.map((s) => (
                <label key={s.code} className={`launch-svc${s.startable ? '' : ' disabled'}`}>
                  <input
                    type="checkbox"
                    disabled={!s.startable}
                    checked={selected.has(s.code)}
                    onChange={() => toggle(s.code)}
                  />
                  <span className="svc-name">{s.name}</span>
                  <span className="svc-meta">
                    {s.component ?? s.runtime}
                    {s.port ? ` :${s.port}` : ''}
                    {s.monitor_only ? ' · monitor' : ''}
                  </span>
                  <span className={stateBadge(s.state)}>{s.state}</span>
                </label>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PreflightView({ report }: { report: PreflightReport }) {
  return (
    <div className={`preflight ${report.ok ? 'ok' : 'warn'}`}>
      <strong>起動前チェック: {report.ok ? 'OK' : '要確認'}</strong>
      {report.needsIdentity && !report.identityPresent && (
        <p className="fail">⚠ Infisical machine identity (INFISICAL_*) が未設定 — inject 対象は起動に失敗します</p>
      )}
      <ul>
        {report.services.map((s) => (
          <li key={s.code} className={s.ready ? 'ok' : 'fail'}>
            {s.ready ? '✓' : '✗'} {s.name}
            {s.injectedKeys > 0 ? ` (env ${s.injectedKeys})` : ''}
            <ul>
              {s.checks
                .filter((c) => c.status !== 'ok')
                .map((c, i) => (
                  <li key={i} className={c.status}>
                    {c.kind}: {c.detail}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultView({ result }: { result: LaunchResult }) {
  return (
    <div className="launch-result">
      <strong>起動結果</strong>
      <ul>
        {result.results.map((r) => (
          <li key={r.code} className={r.skipped ? 'warn' : r.ok ? 'ok' : 'fail'}>
            {r.skipped ? '⏭' : r.ok ? '✓' : '✗'} {r.code} — {r.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
