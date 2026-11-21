import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:c52cb2c6 */
import augurContract_1aae4c7b from './deadline.contract.js'; /* augur-inject:contract-predicate:0317650e */
import augurContract_0c59f2df from './inputs.contract.js'; /* augur-inject:contract-predicate:c4b4ec15 */
/** @implements SPEC-EX-AWS-COMPUTE C-29 */
export function resolveDeadline(deadline: number, now: number, maxRuntimeSeconds: number): number | null {
  return deadline <= now ? null : Math.min(deadline, now + maxRuntimeSeconds * 1000);
}
// @ts-expect-error augur-inject
resolveDeadline = contract(resolveDeadline, { ...augurContract_1aae4c7b, contractId: 'C-29', mode: 'observe', sample: 1, where: 'src/aws-compute/limits.ts:2', rule: 'contract-wrap', id: '1aae4c7b' }); /* augur-inject:contract-wrap:1aae4c7b */

/** @implements SPEC-EX-AWS-COMPUTE C-30 */
export function selectRunnerInputs(allowed: readonly string[], inputs: Record<string, string>): Record<string, string> | null {
  if (Object.keys(inputs).some((key) => !allowed.includes(key))) return null;
  return Object.fromEntries(Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right)));
}
// @ts-expect-error augur-inject
selectRunnerInputs = contract(selectRunnerInputs, { ...augurContract_0c59f2df, contractId: 'C-30', mode: 'observe', sample: 1, where: 'src/aws-compute/limits.ts:7', rule: 'contract-wrap', id: '0c59f2df' }); /* augur-inject:contract-wrap:0c59f2df */
