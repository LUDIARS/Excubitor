/**
 * この拠点が「どのサービスを担保するか」を解決する (pure)。
 *
 * 担保 = この拠点の Excubitor がそのサービスの死活に責任を持つこと。 種類は 2 つ:
 * - managed:  起動定義 (command / start_script / compose_file / exec) があり、 この拠点の
 *             Excubitor が起動・再起動まで引き受ける
 * - observed: 起動定義が無く、 生存を見るだけ (外で起動される DB、 Excubitor 自身など)
 *
 * 既定は「自拠点の catalog に載っていて disabled でない」サービス。 拠点ごとの上書き
 * (coverage-prefs.ts) で外せる / 戻せる。
 */

import type { Service } from '../catalog/loader.js';

/** @implements SPEC-FEDERATION-COVERAGE */

export type CoverageKind = 'managed' | 'observed';

export interface ServiceCoverage {
  code: string;
  name: string;
  project_code: string | null;
  kind: CoverageKind;
  /** この拠点が担保しているか (上書き後の実効値)。 */
  covered: boolean;
  /** covered がどこから来たか。 */
  source: 'catalog' | 'override';
}

export function coverageKind(svc: Pick<Service, 'command' | 'start_script' | 'compose_file' | 'exec'>): CoverageKind {
  return svc.command || svc.start_script || svc.compose_file || svc.exec ? 'managed' : 'observed';
}

export function resolveCoverage(
  services: readonly Service[],
  prefs: ReadonlyMap<string, boolean>,
): ServiceCoverage[] {
  return services
    .filter((svc) => !svc.disabled)
    .map((svc) => {
      const override = prefs.get(svc.code);
      return {
        code: svc.code,
        name: svc.name,
        project_code: svc.project_code ?? null,
        kind: coverageKind(svc),
        covered: override ?? true,
        source: override === undefined ? 'catalog' : 'override',
      } satisfies ServiceCoverage;
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}
