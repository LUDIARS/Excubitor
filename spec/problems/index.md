# Excubitor 問題資料 (spec/problems) 目次

障害・クラッシュ等の問題調査と、その改修のための実装資料を置くディレクトリ。
実装担当 (Codex 等) はここの資料単位で作業する。1 作業パッケージ (WP) = 1 PR を原則とする。

## クラッシュ多発問題 (2026-07-09 調査)

「Excubitor 本体がよく落ちる」問題のコード解析と改修資料。全体像は
[`crash-2026-07-analysis.md`](crash-2026-07-analysis.md) を先に読むこと。

| WP | 資料 | 内容 | 優先度 |
|----|------|------|--------|
| WP1 | [`crash-fix-wp1-supervisor.md`](crash-fix-wp1-supervisor.md) | service-runner の道連れ shutdown 廃止 / クラッシュハンドラ内 throw 対策 / docker ps timeout | **最優先** |
| WP2 | [`crash-fix-wp2-child-process.md`](crash-fix-wp2-child-process.md) | 子プロセス管理の共通化 (SIGKILL エスカレーション / 出力サイズ上限 / auto_fix の exec 統一) | 高 |
| WP3 | [`crash-fix-wp3-log-buffers.md`](crash-fix-wp3-log-buffers.md) | ログ系の無制限バッファ対策 (SSE queue / file-tail / process-file / docker-tail / error-detector) | 高 |
| WP4 | [`crash-fix-wp4-db-hygiene.md`](crash-fix-wp4-db-hygiene.md) | DB 衛生 (liveness_history / service_instance_logs retention、busy_timeout、closeDb) | 中 |

実施順は WP1 → WP2 → WP3 → WP4 を推奨。WP 間の依存は WP2 の共通ヘルパを WP3/WP4 が
利用しうる程度で、並行実施も可能。
