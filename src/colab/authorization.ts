import type { FederationCaller } from '../federation/peer-auth.js';
import { permitsMeshAction } from '../federation/security/grants.js';
import { COLAB_RESOURCE, type ColabAction, type ColabSubmit } from './protocol.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:07e902b4 */
import augurContract_49d708aa from './contracts/c-39.contract.js'; /* augur-inject:contract-predicate:d24090a8 */
import augurContract_1b3fe461 from './contracts/c-42.contract.js'; /* augur-inject:contract-predicate:332db2de */

export function authorizeColabStart(input: {
  enabled: boolean;
  ownerId: string;
  request: Pick<ColabSubmit, 'ownerId'> & { ownerStart: boolean };
}): boolean {
  return input.enabled && input.request.ownerStart === true && input.request.ownerId === input.ownerId;
}
// @ts-expect-error augur-inject
authorizeColabStart = contract(authorizeColabStart, { ...augurContract_49d708aa, contractId: 'C-39', mode: 'observe', sample: 1, where: 'src/colab/authorization.ts:5', rule: 'contract-wrap', id: '49d708aa' }); /* augur-inject:contract-wrap:49d708aa */

export function allowsColabPeer(input: {
  hqPeerId?: string;
  caller: FederationCaller;
  action: ColabAction;
  now: number;
}): boolean {
  const { hqPeerId, caller, action, now } = input;
  return caller.authMode === 'cr-v1' && caller.peerId === hqPeerId &&
    permitsMeshAction({ caller, action, resource: COLAB_RESOURCE, now });
}
// @ts-expect-error augur-inject
allowsColabPeer = contract(allowsColabPeer, { ...augurContract_1b3fe461, contractId: 'C-42', mode: 'observe', sample: 1, where: 'src/colab/authorization.ts:13', rule: 'contract-wrap', id: '1b3fe461' }); /* augur-inject:contract-wrap:1b3fe461 */
