export default {
  post: (result: boolean, input: { expected: string | undefined; actual: string }) =>
    !result || (typeof input.expected === 'string' && /^[a-f0-9]{64}$/.test(input.expected) && input.expected === input.actual) || 'unapproved artifact accepted',
};
