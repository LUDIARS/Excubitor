export default {
  post: (result: number | null, deadline: number, now: number, maxRuntimeSeconds: number) =>
    deadline <= now ? result === null : result === Math.min(deadline, now + maxRuntimeSeconds * 1000),
};
