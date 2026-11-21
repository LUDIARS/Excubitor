export default {
  post(result: boolean, input: { endpoint: string | null; activeEndpoints: string[] | null }) {
    if (input.endpoint === null || input.activeEndpoints === null) return result === false;
    return result === input.activeEndpoints.every(endpoint => endpoint !== input.endpoint);
  },
};
