export default {
  post: (result: Record<string, string> | null, allowed: readonly string[], inputs: Record<string, string>) =>
    Object.keys(inputs).some((key) => !allowed.includes(key))
      ? result === null
      : result !== null && Object.keys(result).length === Object.keys(inputs).length
        && Object.entries(result).every(([key, value]) => Object.hasOwn(inputs, key) && inputs[key] === value),
};
