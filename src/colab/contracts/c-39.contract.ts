export default {
  post(result: boolean, input: {
    enabled: boolean; ownerId: string; request: { ownerId: string; ownerStart: boolean };
  }) {
    return result === (input.enabled && input.ownerId === input.request.ownerId && input.request.ownerStart === true);
  },
};
