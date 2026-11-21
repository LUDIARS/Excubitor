export default {
  post(result: { kind: string; job?: { id: string } }, input: {
    existing?: { id: string; fingerprint: string }; fingerprint: string; busy: boolean;
  }) {
    if (input.existing) {
      if (input.existing.fingerprint !== input.fingerprint) return result.kind === 'conflict';
      return result.kind === 'existing' && result.job?.id === input.existing.id;
    }
    return result.kind === (input.busy ? 'busy' : 'created');
  },
};
