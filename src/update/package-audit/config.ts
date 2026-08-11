/**
 * パッケージ監査の運用設定を Excubitor runtime config から読む。
 *
 * サービス定義は各リポの `excubitor.catalog.yaml` が正本で、Excubitor 固有の運用設定は
 * `excubitor.config.yaml` に集約する (catalog/ 配下に Excubitor 所有の設定は置かない)。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { z } from 'zod';

import { DEFAULT_RUNTIME_CONFIG_PATH, readRuntimeConfig } from '../../catalog/runtime-config.js';

const SHELL_META_PATTERN = /[\r\n&|<>^%!"()]/;
const CommandSchema = z.string().min(1).refine(
  (value) => !SHELL_META_PATTERN.test(value),
  'global CLI command must not contain shell metacharacters',
);
const CommandArgumentSchema = z.string().min(1).refine(
  (value) => !SHELL_META_PATTERN.test(value),
  'global CLI version argument must not contain shell metacharacters',
);

const GlobalCliSchema = z.object({
  id: z.string().min(1),
  command: CommandSchema,
  npm_package: z.string().min(1).optional(),
  workspace_package: z.string().min(1).optional(),
  version_args: z.array(CommandArgumentSchema).default(['--version']),
  required: z.boolean().default(true),
}).refine(
  (target) => Boolean(target.npm_package || target.workspace_package),
  'global CLI requires npm_package or workspace_package',
);

const PackageAuditConfigSchema = z.object({
  include_unlisted_npm_globals: z.boolean().default(true),
  global_cli: z.array(GlobalCliSchema).default([]),
  release_notes: z.object({
    enabled: z.boolean().default(true),
    max_packages: z.number().int().nonnegative().default(40),
  }).default({}),
});

export type PackageAuditConfig = z.infer<typeof PackageAuditConfigSchema>;
export type GlobalCliTarget = z.infer<typeof GlobalCliSchema>;

/**
 * `package_audit:` セクションを読む。未宣言でも既定値で動く (global CLI 宣言が無いだけ)。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */
export function loadPackageAuditConfig(
  path = process.env.EXCUBITOR_PACKAGE_AUDIT_CONFIG?.trim() || DEFAULT_RUNTIME_CONFIG_PATH,
): PackageAuditConfig {
  return PackageAuditConfigSchema.parse(readRuntimeConfig(path).package_audit ?? {});
}
