/** @implements SPEC-EX-NETWATCH */
/**
 * Tela のデスクトップオーバーレイに渡す一覧ファイル (`TELA_LIST_VIEW 1`) を組み立てる。
 * Tela 側は通信監視を知らず、 「印つきの行の一覧」 として描くだけにする (表示は名前に依存しない)。
 *
 * 形式 (UTF-8・BOM なし・改行 LF):
 *   TELA_LIST_VIEW 1
 *   title\t<見出し>
 *   status\t<状態の 1 行>
 *   row\t<alert|normal|muted>\t<列1>\t<列2>\t<列3>\t<列4>
 * 値に含まれるタブ・改行・制御文字は空白にする。 1 値は 4096 バイト、 行は 256 行まで。
 */

export const TELA_LIST_MAGIC = 'TELA_LIST_VIEW 1';
const MAX_VALUE_BYTES = 4096;
export const MAX_LIST_ROWS = 256;

export type RowMark = 'alert' | 'normal' | 'muted';

export interface ListRow {
  mark: RowMark;
  columns: string[];
}

export interface ListView {
  title: string;
  status: string;
  rows: ListRow[];
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (Buffer.byteLength(flat, 'utf8') <= MAX_VALUE_BYTES) return flat;
  let cut = flat;
  while (Buffer.byteLength(cut, 'utf8') > MAX_VALUE_BYTES - 3) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/** 一覧を `TELA_LIST_VIEW 1` の文字列にする。 */
export function renderListView(view: ListView): string {
  const lines = [TELA_LIST_MAGIC, `title\t${clean(view.title)}`, `status\t${clean(view.status)}`];
  for (const row of view.rows.slice(0, MAX_LIST_ROWS)) {
    lines.push(['row', row.mark, ...row.columns.map(clean)].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
