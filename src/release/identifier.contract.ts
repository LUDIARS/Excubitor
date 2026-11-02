export default {
  post(result: boolean, value: unknown): boolean | string {
    const expected = typeof value === 'string' && value.length >= 1 && value.length <= 64
      && /^[0-9A-Za-z]/.test(value) && !/[^0-9A-Za-z._+-]/.test(value);
    return result === expected || 'release identifier validation differs from the allowed format';
  },
};
