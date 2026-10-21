import { useEffect, useState } from 'react';
import {
  fetchConfig,
  saveDomainRoot,
  saveCfTunnel,
  fetchNotificationConfig,
  saveDiscordNotificationConfig,
  testDiscordNotification,
  savePackageAuditDiscordConfig,
  testPackageAuditDiscord,
  type OperationalConfig,
  type DiscordNotificationStatus,
  type PackageAuditDiscordStatus,
} from '../lib/api';
import GeniusRuntimeConfigCard from '../components/GeniusRuntimeConfigCard';
import CfTunnelRoutesCard from '../components/CfTunnelRoutesCard';
import DailyUpdateCard from '../components/DailyUpdateCard';

export default function Config() {
  const [cfg, setCfg] = useState<OperationalConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [domainRootDraft, setDomainRootDraft] = useState('');
  const [cfHostnamesDraft, setCfHostnamesDraft] = useState('');
  const [cfTunnelResult, setCfTunnelResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [discord, setDiscord] = useState<DiscordNotificationStatus | null>(null);
  const [discordWebhook, setDiscordWebhook] = useState('');
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [discordThreshold, setDiscordThreshold] = useState(60);
  const [discordRecovery, setDiscordRecovery] = useState(true);
  const [discordPeerAlerts, setDiscordPeerAlerts] = useState(false);
  const [discordTest, setDiscordTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [packageAuditDiscord, setPackageAuditDiscord] = useState<PackageAuditDiscordStatus | null>(null);
  const [packageAuditWebhook, setPackageAuditWebhook] = useState('');
  const [packageAuditEnabled, setPackageAuditEnabled] = useState(false);
  const [packageAuditTest, setPackageAuditTest] = useState<{ ok: boolean; message: string } | null>(null);

  const load = async () => {
    const [c, notification] = await Promise.all([
      fetchConfig(),
      fetchNotificationConfig(),
    ]);
    setCfg(c);
    setDomainRootDraft(c.domain_root.value);
    // 解決値 (env 優先) ではなく config store の素の値を下書きにする。 解決値を入れると
    // env が設定されている時に env の値をそのまま保存し、 既存の config を潰してしまう。
    setCfHostnamesDraft(c.cf_tunnel.stored.allowed_hostnames.join(', '));
    setDiscord(notification.discord);
    setDiscordEnabled(notification.discord.enabled);
    setDiscordThreshold(notification.discord.downtime_threshold_sec);
    setDiscordRecovery(notification.discord.notify_recovery);
    setDiscordPeerAlerts(notification.discord.peer_alerts);
    setPackageAuditDiscord(notification.package_audit_discord);
    setPackageAuditEnabled(notification.package_audit_discord.enabled);
  };

  useEffect(() => {
    void load();
  }, []);

  const submitDomainRoot = async () => {
    setBusy('domain-root');
    try {
      await saveDomainRoot(domainRootDraft);
      await load();
    } finally {
      setBusy(null);
    }
  };

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  const submitCfTunnel = async () => {
    setBusy('cf-tunnel');
    setCfTunnelResult(null);
    try {
      await saveCfTunnel({
        allowed_hostnames: cfHostnamesDraft
          .split(',')
          .map((h) => h.trim())
          .filter((h) => h.length > 0),
      });
      await load();
      setCfTunnelResult({ ok: true, message: 'Saved' });
    } catch (err) {
      // 保存は hostname 検証で 400 になりうる。 握り潰すと「押しても何も起きない」
      // 無言失敗になるので理由を出す。
      setCfTunnelResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const submitDiscord = async () => {
    setBusy('discord');
    setDiscordTest(null);
    try {
      await saveDiscordNotificationConfig({
        webhook_url: discordWebhook.trim() || undefined,
        enabled: discordEnabled,
        downtime_threshold_sec: discordThreshold,
        notify_recovery: discordRecovery,
        peer_alerts: discordPeerAlerts,
      });
      setDiscordWebhook('');
      await load();
    } catch (err) {
      setDiscordTest({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runDiscordTest = async () => {
    setBusy('discord-test');
    setDiscordTest(null);
    try {
      setDiscordTest(await testDiscordNotification());
    } catch (err) {
      setDiscordTest({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  /** @implements SPEC-PACKAGE-UPDATE-AUDIT */
  const submitPackageAuditDiscord = async () => {
    setBusy('package-audit-discord');
    setPackageAuditTest(null);
    try {
      await savePackageAuditDiscordConfig({
        webhook_url: packageAuditWebhook.trim() || undefined,
        enabled: packageAuditEnabled,
      });
      setPackageAuditWebhook('');
      await load();
    } catch (err) {
      setPackageAuditTest({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  /** @implements SPEC-PACKAGE-UPDATE-AUDIT */
  const runPackageAuditDiscordTest = async () => {
    setBusy('package-audit-discord-test');
    setPackageAuditTest(null);
    try {
      setPackageAuditTest(await testPackageAuditDiscord());
    } catch (err) {
      setPackageAuditTest({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!cfg) return <div className="config">読み込み中…</div>;

  const domainRoot = cfg.domain_root;
  const cfTunnel = cfg.cf_tunnel;

  return (
    <div className="config">
      <section className="config-card">
        <h2>Domain root</h2>
        <p className="muted">
          Injected into all services through catalog global.env as <code>LUDIARS_ALLOWED_HOSTS</code>.
          Current: <strong>{domainRoot.value || '(unset)'}</strong> ({domainRoot.source})
        </p>
        <p className="muted small">
          Saved at <code>{domainRoot.storePath}</code>.
          {domainRoot.env ? <> <code>EXCUBITOR_DOMAIN_ROOT</code> is set, so env takes precedence.</> : null}
        </p>
        <div className="config-form">
          <label>
            Domain root
            <input
              value={domainRootDraft}
              onChange={(e) => setDomainRootDraft(e.target.value)}
              placeholder="example.com"
            />
          </label>
          <div className="config-actions">
            <button
              className="primary"
              disabled={busy !== null || !domainRootDraft.trim()}
              onClick={() => void submitDomainRoot()}
            >
              {busy === 'domain-root' ? 'Saving...' : 'Save domain root'}
            </button>
          </div>
        </div>
      </section>

      <section className="config-card">
        <h2>CF Tunnel broker</h2>
        <p className="muted">
          Cloudflare Tunnel route broker settings. The CF API token itself lives in the Excubitor
          Vault (環境変数 tab, keys <code>CF_API_TOKEN</code> / <code>CF_ACCOUNT_ID</code>; no service
          binding needed). Configure here which public hostnames the broker may modify (fail-closed
          when empty).
        </p>
        <p className="muted small">
          Saved at <code>{cfTunnel.storePath}</code>. These fields edit the stored config; when the
          matching env var is set it takes precedence and the stored value stays unused.
          {cfTunnel.allowed_hostnames_source === 'env'
            ? <> <code>EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES</code> is set, so env takes precedence.</>
            : null}
          {cfTunnel.direct_env_credentials
            ? <> Direct env credentials (<code>EXCUBITOR_CF_API_TOKEN</code>) are set and win over the Vault.</>
            : null}
        </p>
        <div className="config-form">
          <label>
            Allowed hostnames (in effect: {cfTunnel.allowed_hostnames_source}, comma separated)
            <input
              value={cfHostnamesDraft}
              onChange={(e) => setCfHostnamesDraft(e.target.value)}
              placeholder="qs-magiclink.example.com, other.example.com"
            />
          </label>
          <div className="config-actions">
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() => void submitCfTunnel()}
            >
              {busy === 'cf-tunnel' ? 'Saving...' : 'Save CF Tunnel settings'}
            </button>
          </div>
          {cfTunnelResult && (
            <p className={`muted small ${cfTunnelResult.ok ? 'ok' : 'fail'}`}>
              {cfTunnelResult.ok ? '✓' : '✗'} {cfTunnelResult.message}
            </p>
          )}
        </div>
      </section>

      <CfTunnelRoutesCard busy={busy} setBusy={setBusy} />

      <section className="config-card">
        <h2>Discord downtime notifications</h2>
        <p className="muted">
          Sends one alert after a service has failed health checks continuously for at least one minute,
          and optionally sends a recovery message. Webhook URLs are encrypted at rest and are never returned by the API.
        </p>
        <p className="muted small">
          Current: <strong className={discord?.configured ? 'ok' : 'fail'}>
            {discord?.configured ? 'configured' : 'not configured'}
          </strong> ({discord?.source ?? 'unset'}). Saved at <code>{discord?.storePath ?? domainRoot.storePath}</code>.
        </p>
        <div className="config-form">
          <label>
            Discord webhook URL
            <input
              type="password"
              value={discordWebhook}
              onChange={(event) => setDiscordWebhook(event.target.value)}
              placeholder={discord?.configured ? '(enter only to replace)' : 'https://discord.com/api/webhooks/...'}
            />
          </label>
          <label>
            Downtime threshold (seconds, minimum 60)
            <input
              type="number"
              min={60}
              max={86400}
              value={discordThreshold}
              onChange={(event) => setDiscordThreshold(Number(event.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={discordEnabled}
              onChange={(event) => setDiscordEnabled(event.target.checked)}
            /> Enable Discord notifications
          </label>
          <label>
            <input
              type="checkbox"
              checked={discordRecovery}
              onChange={(event) => setDiscordRecovery(event.target.checked)}
            /> Notify when the service recovers
          </label>
          <label title="相互登録で全拠点が互いを巡回するので、本社 1 拠点だけで有効にする">
            <input
              type="checkbox"
              checked={discordPeerAlerts}
              onChange={(event) => setDiscordPeerAlerts(event.target.checked)}
            /> 本社として拠点の応答なし・資源アラート (ストレージ / メモリ / CPU) を通知する
          </label>
          <div className="config-actions">
            <button className="primary" disabled={busy !== null} onClick={() => void submitDiscord()}>
              {busy === 'discord' ? 'Saving...' : 'Save Discord settings'}
            </button>
            <button
              disabled={busy !== null || !discord?.configured || !discordEnabled}
              onClick={() => void runDiscordTest()}
            >
              {busy === 'discord-test' ? 'Sending...' : 'Send test'}
            </button>
          </div>
          {discordTest && (
            <p className={`muted small ${discordTest.ok ? 'ok' : 'fail'}`}>
              {discordTest.ok ? '✓' : '✗'} {discordTest.message}
            </p>
          )}
        </div>
      </section>

      <section className="config-card">
        <h2>Discord package audit reports</h2>
        <p className="muted">
          Sends the daily dependency update and vulnerability report to a dedicated Discord webhook.
          This webhook is separate from downtime alerts, encrypted at rest, and never returned by the API.
        </p>
        <p className="muted small">
          Current: <strong className={packageAuditDiscord?.configured ? 'ok' : 'fail'}>
            {packageAuditDiscord?.configured ? 'configured' : 'not configured'}
          </strong> ({packageAuditDiscord?.source ?? 'unset'}).
          Saved at <code>{packageAuditDiscord?.storePath ?? domainRoot.storePath}</code>.
        </p>
        <div className="config-form">
          <label>
            Package audit Discord webhook URL
            <input
              type="password"
              value={packageAuditWebhook}
              onChange={(event) => setPackageAuditWebhook(event.target.value)}
              placeholder={packageAuditDiscord?.configured
                ? '(enter only to replace)'
                : 'https://discord.com/api/webhooks/...'}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={packageAuditEnabled}
              onChange={(event) => setPackageAuditEnabled(event.target.checked)}
            /> Enable daily package audit reports
          </label>
          <div className="config-actions">
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() => void submitPackageAuditDiscord()}
            >
              {busy === 'package-audit-discord' ? 'Saving...' : 'Save package audit webhook'}
            </button>
            <button
              disabled={busy !== null || !packageAuditDiscord?.configured || !packageAuditEnabled}
              onClick={() => void runPackageAuditDiscordTest()}
            >
              {busy === 'package-audit-discord-test' ? 'Sending...' : 'Send test'}
            </button>
          </div>
          {packageAuditTest && (
            <p className={`muted small ${packageAuditTest.ok ? 'ok' : 'fail'}`}>
              {packageAuditTest.ok ? '✓' : '✗'} {packageAuditTest.message}
            </p>
          )}
        </div>
      </section>

      <GeniusRuntimeConfigCard busy={busy} setBusy={setBusy} />
      <DailyUpdateCard />

    </div>
  );
}
