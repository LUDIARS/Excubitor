import { useEffect, useState } from 'react';
import {
  fetchServiceRuntimeConfig,
  fetchTopology,
  saveServiceRuntimeConfig,
  type ServiceRuntimeConfigStatus,
} from '../lib/api';
import { createGeniusRuntimeConfigTemplate } from '../lib/genius-runtime-config';

const BUSY_KEY = 'genius-runtime-config';

interface Props {
  /** Config ページ全体で共有する進行中フラグ (同時操作を避けるため受け取る)。 */
  busy: string | null;
  setBusy: (value: string | null) => void;
}

/**
 * Genius の暗号化 runtime config を編集する Config ページのカード。
 * 保存値は API から読み戻せないため、下書きは常に空から始める。
 * @implements SPEC-SERVICE-RUNTIME-CONFIG-GENIUS-TEMPLATE
 */
export default function GeniusRuntimeConfigCard({ busy, setBusy }: Props) {
  const [status, setStatus] = useState<ServiceRuntimeConfigStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [runtimeConfig, topology] = await Promise.all([
        fetchServiceRuntimeConfig('genius'),
        fetchTopology().catch((): Record<string, string> => ({})),
      ]);
      setStatus(runtimeConfig);
      setPort(topology.GENIUS_PORT ?? null);
    })();
  }, []);

  const submit = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError('設定は JSON として入力してください。');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('設定の最上位は JSON object である必要があります。');
      return;
    }
    setBusy(BUSY_KEY);
    try {
      setStatus(await saveServiceRuntimeConfig('genius', parsed as Record<string, unknown>));
      setDraft('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    const confirmed = window.confirm(
      '保存済みの Genius runtime configuration を削除しますか？この操作は元に戻せません。',
    );
    if (!confirmed) return;
    setBusy(BUSY_KEY);
    setError(null);
    try {
      setStatus(await saveServiceRuntimeConfig('genius', null));
      setDraft('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="config-card">
      <h2>Genius runtime configuration</h2>
      <p className="muted">
        Genius の起動設定を <code>config.enc</code> に暗号化して保存し、起動時だけ対象プロセスへ渡します。
        値は API から再表示されません。変更時は完全な JSON object を入力してください。
      </p>
      <p className="muted small fail">
        Genius 側はまだ <code>EXCUBITOR_SERVICE_CONFIG_JSON</code> を読みません
        (loader 対応は Genius repository の follow-up)。保存しても起動設定は変わらないため、
        <code>genius.config.json</code> は削除しないでください。
      </p>
      <p className="muted small">
        現在: <strong className={status?.configured ? 'ok' : 'fail'}>
          {status?.configured ? '設定済み' : '未設定'}
        </strong>
        {status?.keys.length ? <> — keys: <code>{status.keys.join(', ')}</code></> : null}
      </p>
      <div className="config-form">
        <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
          <code>dataDir</code>、embedding、distill、通知、質問、矛盾検出、query log、全 source を
          「全項目を入力」で読み込みます。保存済みの本文は安全のため再表示できません。
        </p>
        <label style={{ gridColumn: '1 / -1' }}>
          Full Genius configuration JSON
          <textarea
            rows={32}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="「全項目を入力」で現在の設定項目を展開します。"
          />
        </label>
        <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
          HTTP port は入力不要です。Excubitor の service catalog / ProcessMap が
          <code>GENIUS_PORT</code> を供給します{port ? <>（現在 <code>{port}</code>）</> : ''}。
        </p>
        <div className="config-actions" style={{ gridColumn: '1 / -1' }}>
          <button
            disabled={busy !== null}
            onClick={() => {
              setDraft(createGeniusRuntimeConfigTemplate());
              setError(null);
            }}
          >
            全項目を入力
          </button>
          <button
            className="primary"
            disabled={busy !== null || !draft.trim()}
            onClick={() => void submit()}
          >
            {busy === BUSY_KEY ? 'Saving...' : 'Save encrypted Genius config'}
          </button>
          <button
            disabled={busy !== null || !status?.configured}
            onClick={() => void clear()}
          >
            Clear configuration
          </button>
        </div>
        {error ? <p className="muted small fail">✗ {error}</p> : null}
      </div>
    </section>
  );
}
