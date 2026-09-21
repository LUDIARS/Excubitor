/**
 * Federation API (`/api/v1/peers/*` + `/api/v1/federation/*` + `/api/v1/operations`) の組み立て。
 *
 * 面ごとの実装は別ファイルに置き、 ここは束ねるだけ:
 *  - 他拠点向け公開面 (相互登録の署名付き要求だけ): public-router.ts。 同じインスタンスを
 *    メッシュ側の拠点間リスナー (listener.ts) にも載せる (再送防止の nonce を共有するため)
 *  - 本拠点の identity: mesh-routes.ts `buildSelfRoutes`
 *  - メッシュ集約・担保・旧形式の集約ビュー: mesh-routes.ts `buildMeshRoutes`
 *  - ピア CRUD / 疎通テスト: peer-routes.ts
 *  - 依頼: 自拠点 operations/local-routes.ts、 ピアへの中継 operations/peer-operation-routes.ts
 * 公開面以外は loopback の本体 (17332) にだけ載る。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { buildMeshRoutes, buildSelfRoutes } from './mesh-routes.js';
import { buildPeerCrudRoutes, buildPeerTestRoutes } from './peer-routes.js';
import { buildOperationLocalRoutes } from './operations/local-routes.js';
import { buildPeerOperationRoutes } from './operations/peer-operation-routes.js';
import type { OperationRunner } from './operations/runner.js';
import type { FederationListenerStatus } from './listener.js';
import type { FederationEnv } from './peer-auth.js';
import type { RemotePeer } from './store.js';

/** @implements SPEC-FEDERATION-MESH */

export interface FederationRouterOptions {
  getCatalog: () => Catalog;
  getListenerStatus: () => FederationListenerStatus;
  runner: OperationRunner;
  /** buildFederationPublicRouter で作った公開面 (拠点間リスナーと共有する)。 */
  publicRouter: Hono<FederationEnv>;
}

export function buildFederationRouter(options: FederationRouterOptions): Hono {
  const app = new Hono();
  app.route('/', options.publicRouter);
  app.route('/', buildSelfRoutes(options.getListenerStatus));
  app.route('/', buildMeshRoutes(options.getCatalog, options.getListenerStatus));
  app.route('/', buildPeerCrudRoutes());
  app.route('/', buildPeerTestRoutes(options.getCatalog));
  app.route('/', buildOperationLocalRoutes({ getCatalog: options.getCatalog, runner: options.runner }));
  app.route('/', buildPeerOperationRoutes());
  return app;
}

// re-export for callers/tests
export type { RemotePeer };
