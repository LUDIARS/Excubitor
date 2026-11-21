import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:7a67b720 */
import augurContract_97362a3e from './contracts/c-41.contract.js'; /* augur-inject:contract-predicate:29031b7d */
export function releaseConfirmed(input: {
  endpoint: string | null;
  activeEndpoints: string[] | null;
}): boolean {
  return input.endpoint !== null && input.activeEndpoints !== null && !input.activeEndpoints.includes(input.endpoint);
}
// @ts-expect-error augur-inject
releaseConfirmed = contract(releaseConfirmed, { ...augurContract_97362a3e, contractId: 'C-41', mode: 'observe', sample: 1, where: 'src/colab/release.ts:1', rule: 'contract-wrap', id: '97362a3e' }); /* augur-inject:contract-wrap:97362a3e */
