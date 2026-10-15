/**
 * Ergo 更新配送ジョブの運用設定を Excubitor runtime config (`ergo_watch:`) から読む。
 *
 * webhook はここに置かない (暗号化 config だけ)。 Revisor / Concordia のポートも書かず、
 * catalog のサービス code だけを持つ。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { z } from 'zod';

import { DEFAULT_RUNTIME_CONFIG_PATH, readRuntimeConfig } from '../../catalog/runtime-config.js';

const SHELL_META_PATTERN = /[\r\n&|<>^%!"()]/;

const ErgoWatchConfigSchema = z.object({
  /** `ergo_pkg` の実行ファイル。 `${ARS_ROOT}` は runtime config の読み取りで補間される。 既定は PATH 上の `ergo_pkg`。 */
  ergo_pkg: z.string().min(1).refine(
    (value) => !SHELL_META_PATTERN.test(value),
    'ergo_pkg must not contain shell metacharacters',
  ).default('ergo_pkg'),
  /**
   * 配送先。 concordia は Concordia の `/v1/events/package-updates` 経由でデプロイ通知チャンネルへ、
   * discord は暗号化 config の webhook へ直送。
   */
  delivery: z.enum(['concordia', 'discord']).default('concordia'),
  /** URL を catalog から引くサービス code。 */
  revisor_service: z.string().min(1).default('revisor'),
  concordia_service: z.string().min(1).default('concordia'),
  /** 日次要約を送る時 (ローカル時刻、 その時以降の最初の回で 1 本)。 */
  summary_hour: z.number().int().min(0).max(23).default(9),
  timeout_ms: z.number().int().positive().default(600_000),
});

export type ErgoWatchConfig = z.infer<typeof ErgoWatchConfigSchema>;

/** `ergo_watch:` セクションを読む。 未宣言でも既定値で動く。 */
export function loadErgoWatchConfig(path = DEFAULT_RUNTIME_CONFIG_PATH): ErgoWatchConfig {
  return ErgoWatchConfigSchema.parse(readRuntimeConfig(path).ergo_watch ?? {});
}
