# 単発 Claude 起動の共通化

調査、自動修正、緊急ポート対応の Claude print-mode 起動は @ludiars/one-shot を使用する。lib/lapilli の固定コミットを submodule で取り込み file: 依存で利用する。Node 22.12 以上が必要。初回は submodule update --init -- lib/lapilli の後に npm ci を行う。

共有層は具体的モデルの指定、CLI の実行ファイル解決、サブスクリプション認証用環境の整理を担い、shell を使わない。CLAUDE_CLI_PATH と Git Bash の既存設定は引き続き渡す。未指定モデルは共有の Claude 既定へ解決する。未知の shell wrapper は暗黙実行せず明示エラーになる。

Excubitor はプロンプト、作業ディレクトリ、結果と実行記録、期限と終了処理、調査時の差分確認、修正後検証を所有する。通常コマンドの execCapture は native spawn のまま。サービス制御・監視・supervisor の実行境界は変更しない。権限追加、自動リトライ、API への切替は行わない。

検証は TypeScript build と Revisor の登録回帰検証。実 Claude 呼び出し、自動修正タスク、緊急対応、サービス起動は移行の検証として実行しない。復旧は本変更と submodule 参照を一緒に revert する。
