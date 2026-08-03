export interface SupervisorIdentityLogger {
  info(bindings: { identityApplied: boolean }, message: string): void;
}

export interface SupervisorStarter {
  start(): Promise<void>;
}

/**
 * supervisor 専用プロセスにも Infisical identity を反映してから起動する。
 *
 * machine identity は暗号化 config (`%APPDATA%/Excubitor/config.enc`) にあり、
 * `readIdentity()` は `process.env.INFISICAL_*` しか見ない。 spawn env を解決する
 * `process/inject.ts` の `resolveInjectEnv` / `resolveRequiresSecretEnv` を実行するのは
 * backend ではなく **supervisor プロセス**なので (service-runner → local-control/supervisor
 * → control/manager → process/inject)、 backend (`index.ts`) 側の `applyInfisicalToEnv()`
 * は別プロセスの env を書くだけで、 ここには継承されない。 これを呼ばないと identity が
 * 設定済みでも null に見え、 `requires_secret` / `inject: true` のサービスが全て
 * 「Excubitor has no machine identity」 で起動前段から落ちる。
 *
 * identity が未設定でも起動は止めない。 `applyInfisicalToEnv()` が false を返すだけで、
 * secret を要求しないサービスは通常どおり動かす必要がある。
 *
 * 注意: これで supervisor の `process.env` に全 project を読める credential が載る。
 * spawn 子は supervisor env を継承するため、 `process/manager.ts` の
 * `inheritableSupervisorEnv()` が `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` を
 * 落として relay の project/key 単位の絞り込みを保つ。
 */
export async function startSupervisorWithInfisicalIdentity(
  applyInfisicalToEnv: () => boolean,
  logger: SupervisorIdentityLogger,
  supervisor: SupervisorStarter,
): Promise<boolean> {
  const identityApplied = applyInfisicalToEnv();
  // identityApplied=false でも到達するので、 「適用した」 と断定しない文言にする
  // (未設定時に 「適用済み」 と読める log は identity 障害の切り分けを誤らせる)。
  logger.info({ identityApplied }, 'resolved Infisical identity for supervisor process env');
  await supervisor.start();
  return identityApplied;
}
