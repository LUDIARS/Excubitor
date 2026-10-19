export default {
  post: (result: string[], input: { allowed: readonly string[]; names: readonly string[] }) =>
    result.every(name => input.allowed.includes(name) && input.names.includes(name)) || 'ungranted vault key selected',
};
