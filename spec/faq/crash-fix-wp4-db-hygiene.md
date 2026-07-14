---
tags: [crash, sqlite, retention, db]
date: 2026-07-09
kind: problem
---

# WP4: DB 衛生 (retention / busy_timeout / closeDb)

親資料: [crash-2026-07-analysis.md](crash-2026-07-analysis.md) の #14〜#17。
テーマ: **長期稼働で DB が肥大・競合してプロセスを巻き込むのを防ぐ**。1 PR。

## 4-A. `liveness_history` と `service_instance_logs` に retention を追加

### 対象

- 書き込み側: `src/scanner/sync.ts:145` / `src/scanner/health-state.ts:52`
  (`liveness_history`)、`src/log/bus.ts:41-51` (`service_instance_logs`)
- 参考実装: `src/memory/store.ts:39-42` (`pruneSamples` — `memory_samples` は
  48h retention 済みで、このリポジトリ唯一の prune)

### 現状の問題

`liveness_history` は 10 秒ごと × サービス数、`service_instance_logs` はログ 1 行ごとに
INSERT され、**DELETE がどこにもない** (grep 確認済み)。結果:

- `scanner/downtime.ts:124-152` が `liveness_history` を相関サブクエリで走査しており、
  テーブル成長に比例して遅くなる。better-sqlite3 は同期実行なので、この遅延は
  そのままイベントループ停止時間になる。
- 最終的にディスク枯渇 → `SQLITE_FULL` が全書き込みで throw。

### 実装指示

1. `memory/store.ts` の `pruneSamples` と同じ方式で prune 関数を追加:
   - `liveness_history`: 既定 7 日 (`EXCUBITOR_LIVENESS_RETENTION_DAYS` で上書き可)。
     downtime 集計 (`downtime.ts`) の参照ウィンドウより長いことを確認して既定値を決める
     (集計が 24h 系なら 7 日で十分)。
   - `service_instance_logs`: 既定 48 時間 (`EXCUBITOR_LOG_RETENTION_HOURS` で上書き可)。
     `/logs/recent` 系 API の参照範囲を壊さない値にする。
2. 実行タイミングは memory と同様に周期ループへ組み込む。ただし毎 tick は過剰なので
   1 時間に 1 回程度 (最終 prune 時刻を持って間引く)。DELETE は
   `WHERE ts < ?` に `LIMIT` を付けて分割実行し (例: 1 回 10,000 行)、
   単発の巨大 DELETE でイベントループを止めない。
3. prune 結果 (削除行数) を logger.debug、初回や大量削除時は logger.info で記録。
4. 既存の肥大 DB への配慮: 初回起動時に数百万行を消す可能性があるため、分割 DELETE の
   ループは 1 tick に上限回数を設けて数時間かけて収束させてよい。`VACUUM` は自動では
   実行しない (ブロッキングが長すぎる)。資料としてこの判断を README/コメントに残す。

### 受け入れ条件

- retention 超過行が周期実行で消える (ユニットテスト: 挿入 → 時刻操作 → prune → 件数確認)。
- 1 回の prune 呼び出しの DELETE 件数が上限で頭打ちになる。

## 4-B. log bus の同期 INSERT をバッチ化

### 対象

`src/log/bus.ts:28-52` (`publish` → `persistLine`)

### 現状の問題

ログ 1 行ごとに同期 `db().run(INSERT ... JOIN ...)`。ログストーム時に行数ぶん
イベントループを塞ぐ。

### 実装指示

- 行をメモリ上のバッファに溜め、**200ms ごと or 200 行到達で 1 トランザクションに
  まとめて INSERT** するバッチライタに変更する (better-sqlite3 の `transaction()` 利用)。
- バッファ自体にも上限 (例: 10,000 行) を設け、超過分は drop + ドロップ件数を
  logger.warn (WP3 と同じ思想: 無制限バッファを作らない)。
- shutdown 時 (`bootObservability` の shutdown フック) に flush する。
- 購読者への配信 (`subscribers`) は現行どおり即時。変わるのは永続化だけ。

### 受け入れ条件

- 既存の `/logs/recent` 系 API の結果が (遅延 200ms 以内で) 変わらない。
- 大量 publish 時の DB 呼び出し回数が行数ではなくバッチ数になる。

## 4-C. `busy_timeout` の設定と `closeDb` の徹底

### 対象

- `src/db/schema.ts:274-275` (pragma 設定箇所 — WAL / foreign_keys は設定済み)
- `src/db/index.ts` (`openDb` / `closeDb`)
- `src/db/client.ts` (drizzle ハンドルのキャッシュ `_db`)

### 現状の問題

1. `busy_timeout` が未設定 (既定 0)。二重起動 (service 稼働中に `npm start`)、
   バックアップ/AV ツールの接触などで `SQLITE_BUSY` が**即時同期 throw**。周期ループ内は
   catch されるが、boot 時 migration (schema.ts の write transaction) で起きると
   `server.ts:155` の catch → exit → service manager が再起動 → また BUSY → 再起動ループ。
2. `closeDb()` が raw ハンドルを閉じるが drizzle キャッシュ `_db` をクリアしない。
   shutdown 中に interval / in-flight リクエストが `db()` を呼ぶと閉じたネイティブ
   ハンドルに触る。通常は JS 例外で済むが、ネイティブ層の並行 close は segfault
   (ハンドラで捕捉不能) の古典的経路。

### 実装指示

1. WAL 設定と同じ場所に `db.pragma('busy_timeout = 5000')` を追加。
2. `closeDb()` で `client.ts` の `_db` キャッシュも null クリアする (client.ts に
   reset 関数を追加して index.ts から呼ぶ)。クリア後に `db()` が呼ばれた場合は
   「closed」を示す明確なエラーを throw する (閉じたハンドルへの到達より安全)。
3. shutdown 順序の確認: `shutdownAndExit` (`src/server.ts:163-176`) が
   `await shutdown?.()` (= 各ループ停止) → `closeDb` の順になっていることを確認し、
   ループ停止が interval の「実行中 tick の完了」を待たない場合は、closeDb 側の
   明確なエラーで守る (2 の対応で足りる)。

### 受け入れ条件

- 別プロセスが write lock を持つ状態でも 5 秒までは待って成功する
  (テストは同一プロセス内で 2 コネクション開けば再現可能)。
- `closeDb` 後の `db()` 呼び出しが閉じたハンドルではなく明確なエラーになる。

## 対象外

- `VACUUM` / `PRAGMA incremental_vacuum` の運用 — 初回削減後のファイルサイズ回収は
  手動運用とし、この WP では扱わない (資料 4-A 参照)。
- `redis-cache` の `COMMAND_TIMEOUT_MS = 20ms` 問題 — クラッシュとは無関係の
  性能問題。別 issue 化を推奨。
