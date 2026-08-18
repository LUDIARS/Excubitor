/**
 * health レスポンスボディから「走っているプロセスが名乗る版」を取り出す。
 *
 * AIFormat `RULE_SRE.md` §2 で `/api/health` は `ok` / `service` / `version` を返すと
 * 決めた。 version は catalog cwd の package.json (= ディスク上の版) と突き合わせて
 * 「反映したつもり」 を検出するために使う (version-reconcile.ts)。
 *
 * health は周期的に全サービスへ撃つので、ここは失敗しても probe 本体を
 * 巻き込まないこと (= 例外を投げない・待たない) を最優先にする。
 *
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */

/** 読み込むボディの上限。 health payload は数百 byte で足りる。 */
const MAX_BODY_BYTES = 16 * 1024;

/** version 文字列として受け入れる最大長 (異常な値を DB に入れない)。 */
const MAX_VERSION_LENGTH = 64;

/** ログや JSON 消費側の表示を壊す制御文字。 */
const UNSAFE_VERSION_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * JSON ボディを上限付きで読む。 上限を超えたら null (= 版を名乗っていない扱い)。
 * content-type が JSON でなければ読まずに諦める。
 */
async function readCappedJsonBody(res: Response): Promise<unknown | null> {
  const contentType = res.headers.get('content-type') ?? '';
  const body = res.body;
  if (!body) return null;
  if (!contentType.toLowerCase().includes('json')) {
    await body.cancel().catch(() => undefined); // probe owns the response; best-effort connection release
    return null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined); // broken peer; best-effort connection release
    return null;
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    return null;
  }
}

/** health ボディの `version` を取り出す。 名乗っていなければ null。 */
export async function extractReportedVersion(res: Response): Promise<string | null> {
  const parsed = await readCappedJsonBody(res);
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed as Record<string, unknown>).version;
  if (typeof raw !== 'string') return null;
  const version = raw.trim();
  if (!version || version.length > MAX_VERSION_LENGTH || UNSAFE_VERSION_CHARS.test(version)) return null;
  return version;
}
