/**
 * 他拠点に公開する federation API。 すべて相互登録済みのピアからの署名付き要求だけを通す
 * (peer-auth.ts: 相手が本拠点の token を知っていて、 かつ本拠点が相手を登録している)。
 *
 *   GET  /api/v1/federation/health            担保サービス + キャッシュ済み死活 + つながり + 拠点情報 + 依頼の履歴
 *   GET  /api/v1/federation/node              サマリ + サービス一覧 + host メトリクス (旧形式)
 *   POST /api/v1/federation/operations        依頼 (更新 / 再起動 / デプロイ / 反映 / 起動 / 停止)
 *   GET  /api/v1/federation/operations/:id    依頼の状態
 *   GET  /api/v1/federation/git/bundle        外部に出られない拠点への git bundle
 *
 * このルーターだけが拠点間リスナー (listener.ts、 メッシュ側アドレス) に載る。 ピア管理や
 * 設定などの管理面は載せない。 loopback の本体 (17332) にも同じルーターを載せる。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { localNodeSnapshot } from './node-snapshot.js';
import { localHealthPayload } from './node-health.js';
import { requireMutualPeer, type FederationEnv } from './peer-auth.js';
import type { FederationListenerStatus } from './listener.js';
import { buildOperationPublicRoutes } from './operations/public-routes.js';
import { buildBundleRoutes } from './operations/bundle-routes.js';
import type { OperationRunner } from './operations/runner.js';

/** @implements SPEC-FEDERATION-MUTUAL-AUTH */

export interface FederationPublicDeps {
  getCatalog: () => Catalog;
  getListenerStatus: () => FederationListenerStatus;
  runner: OperationRunner;
}

export function buildFederationPublicRouter(deps: FederationPublicDeps): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();
  // ルート単位で付ける: このルーターは本体 (17332) にも route() で載るので、
  // `/api/v1/federation/*` 全体に掛けると同じ prefix の管理面 (loopback 用) まで塞いでしまう。
  const auth = requireMutualPeer();

  app.get('/api/v1/federation/health', auth, (c) =>
    c.json(localHealthPayload(deps.getCatalog(), deps.getListenerStatus())));

  app.get('/api/v1/federation/node', auth, (c) => c.json(localNodeSnapshot()));

  app.route('/', buildOperationPublicRoutes({ getCatalog: deps.getCatalog, runner: deps.runner, auth }));
  app.route('/', buildBundleRoutes(deps.getCatalog, auth));

  return app;
}
