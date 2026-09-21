/**
 * C-8 の述語モジュール (`augur.contracts.json`)。
 *
 * spawn へ渡す env は全値が string で、runtime config を載せた場合は JSON object
 * として復元できなければならない。 値そのものは理由文字列に載せない。
 */

import { isSerializedJsonObject, isStringEnvMap } from './runtime-config-contract-shapes.js';

const RUNTIME_CONFIG_ENV = 'EXCUBITOR_SERVICE_CONFIG_JSON';

export default {
  post: (result: unknown) => {
    if (!isStringEnvMap(result)) return 'inject env values must all be strings';
    const serialized = result[RUNTIME_CONFIG_ENV];
    if (serialized === undefined) return true;
    return isSerializedJsonObject(serialized) || 'injected runtime config must be a serialized JSON object';
  },
};
