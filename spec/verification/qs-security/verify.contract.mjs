export default {
  /**
   * @spec SPEC-EX-QS-SECURITY-LOCK
   */
  post(result, before, after, release) {
    const key = 'node_modules/qs';
    const previous = before.packages[key];
    const updated = after.packages[key];
    if (!result || previous.version !== '6.16.0' || updated.version !== '6.16.2') return false;
    if (updated.resolved !== release.dist.tarball || updated.integrity !== release.dist.integrity) return false;
    const stripQs = (lock) => {
      const copy = structuredClone(lock);
      delete copy.packages[key];
      return copy;
    };
    return JSON.stringify(stripQs(before)) === JSON.stringify(stripQs(after));
  },
};
