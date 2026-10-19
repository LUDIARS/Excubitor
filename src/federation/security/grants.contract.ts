export default {
  post: (result: boolean, input: { caller: { authMode?: string; expiresAt?: number; grants?: Array<{ action: string; resource: string }> }; action: string; resource: string; now?: number }) =>
    !result || (input.caller.authMode === 'cr-v1' && (input.caller.expiresAt ?? 0) > (input.now ?? Date.now()) && input.caller.grants?.some(
      grant => grant.action === input.action && grant.resource === input.resource,
    )) || (input.caller.authMode === 'legacy-monitor' && input.action === 'monitor') || 'grant was widened',
};
