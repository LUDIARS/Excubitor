import type { WatchArgsInput } from '../watch-args.js';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;

export default {
  post: (result: string[], input: WatchArgsInput) => {
    const valueOf = (flag: string): string[] => result.flatMap((arg, index) => (arg === flag ? [result[index + 1] ?? ''] : []));
    const urls = [...valueOf('--revisor-url'), ...valueOf('--concordia-url')];
    const hosts = valueOf('--host');
    return (
      urls.every((url) => LOOPBACK.test(url))
      && hosts.length === input.hosts.length
      && input.hosts.every((host) => hosts.includes(host.dir))
      && !result.some((arg) => /token|secret|authorization/i.test(arg))
    ) || 'watch args must carry every host and only loopback URLs without credentials';
  },
};
