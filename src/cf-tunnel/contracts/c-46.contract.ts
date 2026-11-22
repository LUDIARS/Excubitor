const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;

/** C-46: only an RFC 7230 token of 1-64 chars, or null, is accepted unchanged. */
export default {
  post(result: string | null, header: unknown) {
    if (result === null) return header === null || 'non-null header accepted as null';
    return (result === header && TOKEN.test(result)) || 'invalid header name accepted';
  },
};
