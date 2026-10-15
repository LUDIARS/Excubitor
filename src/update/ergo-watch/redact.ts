/**
 * 配送本文へ入れる前の秘匿の伏せ字。
 *
 * Ergo は書く前に漏れ検査を通すが、 配送側でも同じ種類 (URL・絶対パス・資格情報の代入・長い 16 進の
 * トークン) を伏せ、 Discord へ出る経路を二重に守る。 SHA は 7 桁に縮めてから載せるので、 ここで
 * 40 桁の 16 進を伏せても本文の版表示は壊れない。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

const RULES: Array<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, '[url]'],
  [/\b(?:token|secret|password|passwd|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '[redacted]'],
  [/\bbearer\s+\S+/gi, '[redacted]'],
  [/\\\\[^\s\\]+\\[^\s"'<>`]*/g, '[path]'],
  [/\b[A-Za-z]:[\\/][^\s"'<>`]*/g, '[path]'],
  [/(?:^|(?<=[\s("'`]))\/(?:Users|home|root|mnt|var|tmp|opt|srv|private)\/[^\s"'<>`]*/g, '[path]'],
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
];

/** 1 つの値を伏せる。 */
export function redactValue(value: string): string {
  let out = value;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/** 伏せ字の後にも残っていてはいけない形が無いか (テストと配送前の最終確認に使う)。 */
export function findSecretLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const [pattern] of RULES) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    if (matches) leaks.push(...matches);
  }
  return leaks;
}
