/**
 * 拠点間専用リスナー。 Tailscale / Cloudflare Mesh 上の自拠点アドレスにだけ bind し、
 * 他拠点向けの federation API (public-router.ts) だけを出す。
 *
 * 本体 (17332) は loopback 専用のまま変えない。 拠点間の通信はこのリスナーだけを通るので、
 * 管理面 (ピア管理・設定・ログ・制御 UI) がメッシュ側へ出ることはない。
 *
 * メッシュのインターフェースは OS 起動直後や VPN 再接続中にまだ無いことがある。 bind に
 * 失敗したアドレスは一定間隔で取り直す (Excubitor の起動は止めない)。
 */

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { parseFederationListenConfig, type ListenAddress } from './listen-config.js';
import { createSourceGuard, normalizeAddress } from './source-guard.js';

/** @implements SPEC-FEDERATION-MESH */

const logger = createNamedLogger('excubitor.federation.listener');

/** bind に失敗したアドレスを取り直す間隔。 */
const REBIND_INTERVAL_MS = 30_000;
/** Excubitor 自身の catalog エントリで拠点間ポートを宣言する role 名。 */
export const FEDERATION_PORT_ROLE = 'federation';

type ClosableServer = {
  close: (cb?: (err?: Error) => void) => void;
  closeAllConnections?: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

/** 拠点間リスナーの状態 (UI の「このノード」欄とピア登録の導線に出す)。 */
export interface FederationListenerStatus {
  enabled: boolean;
  /** 実際に bind できているアドレス (`host:port`)。 */
  listening: string[];
  /** 設定不正で起動しなかったときの理由。 */
  error: string | null;
}

export interface FederationListenerHandle {
  status: () => FederationListenerStatus;
  close: () => Promise<void>;
}

export interface FederationListenerOptions {
  publicRouter: Hono;
  catalog: Catalog;
  env?: Record<string, string | undefined>;
}

/** Excubitor 自身の catalog エントリから拠点間ポートを引く。 無ければ null。 */
export function federationPortFromCatalog(catalog: Catalog): number | null {
  const self = catalog.services.find((svc) => svc.code === 'excubitor');
  return self?.ports?.find((p) => p.role === FEDERATION_PORT_ROLE)?.port ?? null;
}

/**
 * 設定に従って拠点間リスナーを起動する。 未設定なら何も bind しない (enabled: false)。
 * 設定が不正なときは起動せず error を記録する (全インターフェースへの fallback はしない)。
 */
export function startFederationListener(options: FederationListenerOptions): FederationListenerHandle {
  const config = parseFederationListenConfig(options.env ?? process.env, federationPortFromCatalog(options.catalog));
  if (!config.enabled) {
    if (config.error) logger.error({ err: config.error }, 'federation listener not started: invalid configuration');
    const status: FederationListenerStatus = { enabled: false, listening: [], error: config.error };
    return { status: () => status, close: async () => {} };
  }

  const guard = createSourceGuard(config.allow);
  const app = new Hono();
  app.use('*', async (c, next) => {
    const remote = normalizeAddress(getConnInfo(c).remote.address);
    if (!guard.isAllowed(remote)) {
      logger.warn({ remote, path: c.req.path }, 'federation listener rejected connection from outside the allowlist');
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });
  app.route('/', options.publicRouter);
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  const servers = new Map<string, ClosableServer>();
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;

  const keyOf = (address: ListenAddress) => `${address.host}:${address.port}`;

  const bind = (address: ListenAddress): void => {
    if (closed) return;
    const key = keyOf(address);
    const server = serve({ fetch: app.fetch, hostname: address.host, port: address.port }) as unknown as ClosableServer;
    server.on('listening', () => {
      servers.set(key, server);
      logger.info({ address: key }, 'federation listener bound');
    });
    server.on('error', (err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code ?? null;
      logger.warn({ address: key, code, err: (err as Error).message }, 'federation listener bind failed; will retry');
      servers.delete(key);
      server.close();
      if (closed) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        bind(address);
      }, REBIND_INTERVAL_MS);
      timer.unref?.();
      timers.add(timer);
    });
  };

  for (const address of config.addresses) bind(address);

  return {
    status: () => ({ enabled: true, listening: [...servers.keys()], error: null }),
    close: async () => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.all([...servers.values()].map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
        // ピアの poller は keep-alive で接続を持ち続けるので、 待たずに切って close を完了させる。
        server.closeAllConnections?.();
      })));
      servers.clear();
    },
  };
}
