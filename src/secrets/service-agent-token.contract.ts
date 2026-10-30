/** C-21: a verified service token names exactly the service it was minted for. */
export default {
  post: (result: string | null, token: string) => {
    if (result === null) return true;
    return token.startsWith(`exsa1.${result}.`) || 'service token accepted for a different service code';
  },
};
