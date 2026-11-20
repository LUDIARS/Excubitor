export default {
  post(result: string): boolean | string {
    const { distill } = JSON.parse(result);
    return (distill?.model === 'haiku' && distill.sensitiveCheckModel === 'haiku')
      || 'The Genius template must use the haiku role for both Claude model defaults';
  },
};
