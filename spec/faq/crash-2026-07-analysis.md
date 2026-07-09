---
tags: [crash, stability, ops]
date: 2026-07-09
kind: problem
---

# Excubitor クラッシュ多発問題 — コード解析 (2026-07-09)

## 症状

Excubitor 本体 (backend / service-runner) が頻繁に落ちる、または監視が沈黙する。

## 前提: グローバルハンドラは既にある

`src/server.ts:43-55` に `uncaughtException` / `unhandledRejection` の
log-and-continue ハンドラが登録済み。したがって通常の JS 例外・Promise 拒否では
プロセスは死なない。**「落ちる」原因はハンドラで救えない死に方に限定される**:

1. **別プロセス起因** — service-runner (親) からの SIGTERM / `process.exit`
2. **V8 レベルの fatal** — OOM (`Reached heap limit` abort)、ネイティブ層の segfault
3. **ハンドラ内の throw** — `uncaughtException` ハンドラ内で throw すると Node は無条件で即死
4. **リソース枯渇** — fd / PID / ディスクの枯渇で spawn・accept・write が連鎖的に失敗
5. **沈黙停止** — プロセスは生きているが監視ループが永久に止まる (落ちたのと同義)

コード全体 (src/ 約 14,000 行、テスト除く) を精査した結果、上記すべての経路に
該当する実装が見つかった。改修は 4 つの作業パッケージ (WP) に分割した。

## 発見事項サマリ (優先度順)

### 死の直接原因候補 → WP1

| # | 箇所 | 問題 | 死に方 |
|---|------|------|--------|
| 1 | `src/service-runner.ts:24-27` | backend/frontend どちらかの子が exit すると全体を SIGTERM + `process.exit`。vite preview が一時的に落ちるだけで健康な backend も死ぬ | 経路 1 |
| 2 | `src/service-runner.ts:17` | spawn に `'error'` リスナーなし (npm.cmd 不在等で即クラッシュ)。runner 自体にグローバルハンドラなし | 経路 1 |
| 3 | `src/server.ts:44,50` | クラッシュハンドラ内の `logger.error` が try/catch なし。pino は fd 1 への同期書き込みのため、コンソール窓 close 等の EPIPE でハンドラ内 throw → 即死 | 経路 3 |
| 4 | `src/scanner/docker.ts:41-54` | `execDocker` だけ timeout なし。docker daemon が固まると scanner tick が永久に完了せず、死活監視・docker-tail 管理・health 同期がすべて沈黙停止 | 経路 5 |

### リソース枯渇 (fd / PID) → WP2

| # | 箇所 | 問題 |
|---|------|------|
| 5 | `src/shared/exec.ts:45-48` ほか同型 4 箇所 | timeout 時 SIGTERM のみで即 resolve。SIGKILL エスカレーションも close 待ちもなく、SIGTERM を無視する子 (docker / wsl.exe / cmd) が pipe fd を握ったまま溜まる。scanner は 10 秒ごとにサービス数比例で子を fan-out するため毎 tick リーク → EMFILE |
| 6 | `src/auto_fix/runner.ts:309-326` / `investigate.ts:181-198` | ローカル定義の `execCapture` に timeout なし + stdin 未クローズ。`git push` / `gh pr create` が認証プロンプト等で永久ブロック → 子 + pipe 3 本リーク + `inFlight` ロック永久保持 |
| 7 | `src/shared/exec.ts:49-50` ほか全 spawn | stdout/stderr を文字列に無制限蓄積。`process/build.ts` (30 分枠, shell) や Claude CLI (10 分枠) が大量出力するとヒープ上限 abort (経路 2) |
| 8 | `src/process/manager.ts:150,198-210` | spawn `'error'` 時 (exec パス不正等) に `stopProcessLog` が呼ばれず、fd 2 本 + 1s interval + `processes` エントリが永久リーク。サービスは「起動中」のまま wedge |

### OOM 経路 (無制限バッファ) → WP3

| # | 箇所 | 問題 |
|---|------|------|
| 9 | `src/log/sse.ts:47-53` | SSE コネクションごとの `queue` が無制限。遅いクライアント × ログストームで OOM |
| 10 | `src/log/file-tail.ts:98-125` / `src/log/process-file.ts:94-108` | rotation/truncate 検知で offset=0 に戻し、次 poll で**ファイル全体**を単一 `Buffer.alloc` + 同期 `readSync`。巨大ファイルで数百 MB の同期割り当て + イベントループ停止 |
| 11 | 同上 + `src/log/docker-tail.ts:59-75` | 改行が来ない限り行組み立てバッファが無制限成長 |
| 12 | `src/log/docker-tail.ts:56-60` | 子の stdout/stderr stream に `'error'` リスナーなし。spawn `'error'` 時に `tailers` から削除されず再試行不能に wedge |
| 13 | `src/log/error-detector.ts:54-57,103` | DB 由来の regex を全サービス全行に適用。バックトラック爆発 (ReDoS) で CPU 100% 張り付き |

### 漸進的劣化 (数日〜数週間で死に至る) → WP4

| # | 箇所 | 問題 |
|---|------|------|
| 14 | `src/scanner/sync.ts:145` / `src/scanner/health-state.ts:52` | `liveness_history` に retention が一切ない (10 秒ごと × サービス数で永久成長)。`downtime.ts:124-152` がこのテーブルを相関サブクエリで走査 → better-sqlite3 は同期なのでイベントループが徐々に詰まる → 最終的にディスク枯渇 |
| 15 | `src/log/bus.ts:36-51` | `service_instance_logs` も retention なし + ログ 1 行ごとに同期 INSERT |
| 16 | `src/db/schema.ts:274-275` / `src/db/index.ts` | WAL は設定済みだが `busy_timeout` が 0。二重起動やバックアップツール接触で `SQLITE_BUSY` 即 throw。boot 時 migration で起きると exit → service manager 再起動ループ |
| 17 | `src/db/client.ts` / `src/db/index.ts` | `closeDb()` が drizzle キャッシュ (`_db`) をクリアせず、shutdown 中に閉じたネイティブハンドルへアクセスする余地 (segfault は経路 2) |

## 除外済みの仮説 (再調査不要)

- **pino transport worker のクラッシュ**: transport 未使用 (`src/shared/logger.ts`) — 該当せず。
- **tsx watch による意図しない再起動**: `dev` は `npm install && tsc && node dist/server.js`
  (#45 で watch 廃止済み)。`data/` への書き込みで再起動はしない。CLAUDE.md の
  「tsx watch」記述は古い。
- **scanner/memory ループの重複実行**: 両方とも tick 完了を await してから
  `setTimeout` で再スケジュールする方式で、overlap しない。
- **redis-cache**: 生 socket 実装で `'error'` リスナーあり。クラッシュ経路ではない
  (ただし `COMMAND_TIMEOUT_MS` 既定 20ms は実質キャッシュ無効化の別問題)。
- **restart_policy の fork bomb**: backoff 上限 30s + `max_restart` 制限あり — 安全。
- **fetch のハングソケット**: federation / health / metrics の fetch はすべて
  AbortController / `AbortSignal.timeout` 付き — 安全。
- **`process.exit` の野良呼び出し**: `server.ts` の shutdown 経路と service-runner のみ。

## 原因確定のための証拠収集 (改修と並行して推奨)

`writeDiagnostic` (`src/shared/diagnostic-log.ts`) が `data/` 配下に死亡直前の
イベントを残す。次に落ちたとき以下を確認すると、どの経路だったか直接確定できる:

- diagnostics の最終行: `process.exit` の code / `server.boot.failed` / `uncaughtException` の内容
- service manager (nssm / systemd / スケジューラ) 側のログ: exit code
  - 134 (SIGABRT) / 137 (SIGKILL) → OOM (WP2/WP3 が本命)
  - `[service-runner] frontend exited ...` が console log にある → WP1 #1 が本命
- `ls /proc/<pid>/fd | wc -l` (Linux) や handle 数の推移 → fd リーク (WP2 #5)

## 作業パッケージ

実装担当 (Codex 等) はこの資料単位で作業する。1 作業パッケージ (WP) = 1 PR を原則とし、
実施順は WP1 → WP2 → WP3 → WP4 を推奨。WP 間の依存は WP2 の共通ヘルパを WP3/WP4 が
利用しうる程度で、並行実施も可能。

| WP | 資料 | 内容 | 優先度 |
|----|------|------|--------|
| WP1 | [`crash-fix-wp1-supervisor.md`](crash-fix-wp1-supervisor.md) | service-runner の道連れ shutdown 廃止 / クラッシュハンドラ内 throw 対策 / docker ps timeout | **最優先** |
| WP2 | [`crash-fix-wp2-child-process.md`](crash-fix-wp2-child-process.md) | 子プロセス管理の共通化 (SIGKILL エスカレーション / 出力サイズ上限 / auto_fix の exec 統一) | 高 |
| WP3 | [`crash-fix-wp3-log-buffers.md`](crash-fix-wp3-log-buffers.md) | ログ系の無制限バッファ対策 (SSE queue / file-tail / process-file / docker-tail / error-detector) | 高 |
| WP4 | [`crash-fix-wp4-db-hygiene.md`](crash-fix-wp4-db-hygiene.md) | DB 衛生 (liveness_history / service_instance_logs retention、busy_timeout、closeDb) | 中 |
