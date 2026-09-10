# スマホでViewerメニューが埋め込みページに負けて見える

- Date: 2026-09-10
- Status: fixed in working tree
- Area: DMZ Viewer frontend
- Severity: サービス切替メニューの視認・操作に支障

## Summary

利用者がスマホでViewerメニューより他ページが優先されて見えると報告。
最前面表示またはビューのスライドを希望した。

## Evidence

DMZ entryはViewerのみをimportし、Monitor用styles.cssを読み込まない。
viewer.cssの背景・境界色はMonitor側だけに定義されたCSS変数を参照していた。
そのためメニューのbackground指定が無効になり、iframeが透けて見える。
iframe側コンテナの明示的なstacking contextもなかった。端末上の描画順は未確認。

## Regression Context

DMZ分離後、独立フロントに必要なテーマ定義が不足していた。

## Cause

背景色の未定義が確定した問題。端末固有の合成レイヤー問題が併存するかは未確認。

## Fix Requirements

Viewer専用CSSで不透明な背景・文字色を定義する。Monitor全体のCSSは取り込まない。
埋め込み画面z=0、スマホの背景ボタンz=1、メニューz=2を独立した重なり範囲で管理する。
背景タップで閉じ、背面ページへの誤タップを防ぐ。iframeを再生成せず状態を保持する。
デスクトップの横並び表示とメニュー選択・Escapeによる閉じる動作は維持する。

## Verification

差分の静的確認のみ。単体・起動・ブラウザテストは利用者の作業方針に従い未実施。
受け入れ時はスマホ幅で濃い背景を持つサービス画面上にメニューが不透明に重なること、
背景タップ・サービス選択・開閉後のiframe状態維持を確認する。

## Follow-up

マージ後に本体frontendのDMZ bundleをビルドする。静的ファイル配信なので通常は再起動不要。
