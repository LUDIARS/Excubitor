/**
 * Federation API (`/api/v1/peers/*` + `/api/v1/federation/*`) の組み立て。
 *
 * 面ごとの実装は別ファイルに置き、 ここは束ねるだけ:
 *  - 他拠点向け公開面 (agent token): public-router.ts — health / node / control / update。
 *    他拠点からはメッシュ側の拠点間リスナー (listener.ts) 経由で届く
 *  - 本拠点の identity: mesh-routes.ts `buildSelfRoutes`
 *  - メッシュ集約・担保・旧形式の集約ビュー: mesh-routes.ts `buildMeshRoutes`
 *  - ピア CRUD (自拠点の DB だけ): peer-routes.ts `buildPeerCrudRoutes`
 *  - ピアへ通信する操作 (疎通テスト・遠隔操作プロキシ): peer-routes.ts `buildPeerActionRoutes`
 * 公開面以外は loopback の本体 (17332) にだけ載る。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { buildFederationPublicRouter } from './public-router.js';
import { buildMeshRoutes, buildSelfRoutes } from './mesh-routes.js';
import { buildPeerActionRoutes, buildPeerCrudRoutes } from './peer-routes.js';
import type { FederationListenerStatus } from './listener.js';
import type { RemotePeer } from './store.js';

/** @implements SPEC-FEDERATION-MESH */

export interface FederationRouterOptions {
  getCatalog: () => Catalog;
  getListenerStatus: () => FederationListenerStatus;
}

export function buildFederationRouter(options: FederationRouterOptions): Hono {
  const app = new Hono();
  app.route('/', buildFederationPublicRouter(options.getCatalog));
  app.route('/', buildSelfRoutes(options.getListenerStatus));
  app.route('/', buildMeshRoutes(options.getCatalog));
  app.route('/', buildPeerCrudRoutes());
  app.route('/', buildPeerActionRoutes(options.getCatalog));
  return app;
}

// re-export for callers/tests
export type { RemotePeer };
