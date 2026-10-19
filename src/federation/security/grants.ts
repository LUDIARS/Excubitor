import type { FederationCaller } from '../peer-auth.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:ffc09c6a */
import augurContract_8e75d156 from './grants.contract.js'; /* augur-inject:contract-predicate:90be4903 */
import augurContract_ff7d5e3c from './vault-keys.contract.js'; /* augur-inject:contract-predicate:3d3c258b */

export function permitsMeshAction(input: { caller: FederationCaller; action: string; resource: string; now?: number }): boolean {
  const { caller, action, resource } = input;
  if (caller.authMode === 'legacy-monitor') return action === 'monitor';
  if (caller.authMode !== 'cr-v1' || !caller.expiresAt || caller.expiresAt <= (input.now ?? Date.now())) return false;
  return caller.grants?.some(grant => grant.action === action && grant.resource === resource) ?? false;
}
// @ts-expect-error augur-inject
permitsMeshAction = contract(permitsMeshAction, { ...augurContract_8e75d156, contractId: 'C-15', mode: 'observe', sample: 1, where: 'src/federation/security/grants.ts:3', rule: 'contract-wrap', id: '8e75d156' }); /* augur-inject:contract-wrap:8e75d156 */

export function selectVaultKeys(input: { allowed: readonly string[]; names: readonly string[] }): string[] {
  const allowed = new Set(input.allowed);
  return input.names.filter(name => allowed.has(name));
}
// @ts-expect-error augur-inject
selectVaultKeys = contract(selectVaultKeys, { ...augurContract_ff7d5e3c, contractId: 'C-16', mode: 'observe', sample: 1, where: 'src/federation/security/grants.ts:10', rule: 'contract-wrap', id: 'ff7d5e3c' }); /* augur-inject:contract-wrap:ff7d5e3c */

export function vaultKeysFor(caller: FederationCaller, service: string): string[] {
  const resource = `service:${service}`;
  if (!permitsMeshAction({ caller, action: 'vault', resource })) return [];
  return [...new Set(caller.grants?.filter(grant => grant.action === 'vault' && grant.resource === resource)
    .flatMap(grant => grant.keys ?? []) ?? [])];
}
