export default {
  post: (result: boolean, tags: Record<string, string>, owner: string, now: number) => {
    if (!result) return true;
    const expires = Date.parse(tags['ludiars:expires-at'] ?? '');
    return tags['ludiars:owner'] === owner && Boolean(tags['ludiars:job-id'])
      && /^[0-9a-f-]{36}$/.test(tags['ludiars:operation-id'] ?? '')
      && Number.isFinite(expires) && expires <= now;
  },
};
