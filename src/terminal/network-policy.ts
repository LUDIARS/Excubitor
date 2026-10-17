import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { TerminalError, type TerminalTarget } from './schema.js';

/** @implements SPEC-TERMINAL-CONNECTIONS */
const privateNetworks = new BlockList();
for (const [network, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const) {
  privateNetworks.addSubnet(network, prefix, 'ipv4');
}
privateNetworks.addSubnet('fc00::', 7, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && privateNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type AddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** Resolve once; the transport must connect to this exact numeric address (no second DNS lookup). */
export async function resolveTerminalAddress(
  target: TerminalTarget,
  resolve: AddressResolver = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<string> {
  if (target.auth === 'password' && target.network !== 'private') throw new TerminalError('external_requires_key');
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(target.host) ? [{ address: target.host, family: isIP(target.host) }] : await resolve(target.host);
  } catch { throw new TerminalError('dns_failed'); }
  if (!addresses.length || addresses.some((item) => !isIP(item.address))) throw new TerminalError('dns_failed');
  // Mixed public/private DNS answers cannot gain password permission by selecting only the private answer.
  if (target.network === 'private' && !addresses.every((item) => isPrivateAddress(item.address))) {
    throw new TerminalError('not_lan_or_vpn');
  }
  return addresses[0]!.address;
}
