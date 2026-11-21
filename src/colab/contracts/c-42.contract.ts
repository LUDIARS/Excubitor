export default {
  post(result: boolean, input: {
    hqPeerId?: string; action: string; now: number;
    caller: { peerId: string; authMode?: string; expiresAt?: number; grants?: { action: string; resource: string }[] };
  }) {
    const caller = input.caller;
    const exactGrant = caller.grants?.find(grant => grant.action === input.action && grant.resource === 'service:colab-site-runner');
    return result === (caller.authMode === 'cr-v1' && caller.peerId === input.hqPeerId &&
      (caller.expiresAt ?? 0) > input.now && Boolean(exactGrant));
  },
};
