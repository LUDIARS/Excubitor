import { encryptJson, decryptJson } from './crypto.js';
import { masterSecret } from './master-key.js';
import type { OpenedBlob } from './master-key.js';

/** C-23: anything opened with a legacy key round-trips under the stored master key. */
export default {
  post: (result: OpenedBlob<unknown>) => {
    if (!result.legacy) return true;
    const key = masterSecret();
    return JSON.stringify(decryptJson(encryptJson(result.value, key), key)) === JSON.stringify(result.value)
      || 'legacy blob cannot be re-encrypted with the stored master key';
  },
};
