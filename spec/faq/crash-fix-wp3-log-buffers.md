---
tags: [crash, log, sse, oom]
date: 2026-07-09
kind: problem
---

# WP3: ログ系の無制限バッファ対策 (OOM 経路の遮断)

親資料: [crash-2026-07-analysis.md](crash-2026-07-analysis.md) の #9〜#13。
テーマ: **ログを扱うすべての経路にサイズ上限を入れる**。OOM は
uncaughtException ハンドラで救えない即死。1 PR。

## 3-A. SSE のコネクションごとキューに上限

### 対象

`src/log/sse.ts:41-87` (`streamFiltered`)

### 現状の問題

bus 購読で全マッチ行を `queue.push` (:51) し、消費は 1 行ずつ `await stream.writeSSE`
(:72-81)。フィルタなし `/logs` を開いた遅いクライアントがいると、生成レート >
書き込みレートの間 queue が無制限成長する。クライアント数 × 無制限 = OOM の最短経路。

### 実装指示

- queue に上限 (定数 `MAX_QUEUE = 5000` 程度) を設ける。超過時は **drop-oldest**
  (`queue.shift()`) し、ドロップ数をカウント。
- ドロップが発生したら、次の送信機会に `event: 'dropped', data: {count}` を 1 回送って
  クライアントに欠落を通知し、カウンタをリセットする。
- frontend (`frontend/` の LogsDrawer 等) が `dropped` イベントを受けたら
  「N 行スキップ」の表示を挟む (frontend 側は最小対応でよい。未対応でも未知イベントは
  無視されるため backend 先行で入れて問題ない)。

### 受け入れ条件

- 消費を止めた購読者に大量 publish しても queue 長が上限で頭打ちになる (ユニットテスト)。
- 通常速度のクライアントでは挙動が変わらない。

## 3-B. file-tail / process-file の読み取りチャンク上限と rotation 時スキップ

### 対象

- `src/log/file-tail.ts:86-125` (`poll` / `readMore`、offset リセットは :92 と :106)
- `src/log/process-file.ts:88-110` (`drain` / `readNew`、offset リセットは :94)

### 現状の問題

```ts
const need = stat.size - state.offset;
const buffer = Buffer.alloc(need);          // ← need は無制限
fs.readSync(fd, buffer, 0, need, offset);   // ← 同期・イベントループ停止
```

- truncate/rotation 検知 (`size < offset`) で `offset = 0` に戻すため、次の poll で
  **ファイル全体**を 1 発読みする。巨大な日次 JSONL だと数百 MB の同期割り当て
  (>2GiB なら `ERR_OUT_OF_RANGE`)。1 秒周期 × 全サービスで走る。
- 追記バーストでも同様に `need` が跳ねる。

### 実装指示

1. 1 poll あたりの読み取りに上限 (定数 `MAX_READ_BYTES = 1MB` 程度) を設ける。
   `need > MAX_READ_BYTES` の場合は上限分だけ読み、残りは次 poll に持ち越す
   (offset を読んだ分だけ進める)。持ち越し中もイベントループを 1MB/秒以上塞がない。
2. rotation/truncate 検知時 (`size < offset`) は `offset = 0` ではなく
   **`offset = max(0, size - MAX_READ_BYTES)`** にして末尾へスキップする
   (tail の意味論として過去分の再送は不要)。スキップしたことを logger.debug で記録。
3. 行組み立てバッファ (`state.buf` / `bufs[channel]`) に上限 (定数
   `MAX_LINE_BYTES = 64KB` 程度)。超過したら強制的に 1 行として publish
   (末尾に `[line truncated]` マーク) してバッファをクリアする。
   改行の来ないバイナリ/巨大 JSON 出力で無制限成長するのを防ぐ。

### 受け入れ条件

- 100MB 超のファイルを rotation 検知させても、単一 poll の読み取りが上限で頭打ちになり
  末尾スキップされる (既存の `file-tail.test.ts` に追加)。
- 改行なしの長大出力で buf が上限を超えない。

## 3-C. docker-tail の行バッファ上限と stream error

### 対象

`src/log/docker-tail.ts:56-76` (`attachReader`)

### 現状の問題

- `buf += chunk` (:61) に上限がない (3-B と同じパターン)。
- `child.stdout` / `child.stderr` に `'error'` リスナーがない (:60 は `'data'` のみ)。
  docker daemon 死亡時等の pipe エラーが「リスナーなし `'error'`」として
  uncaughtException に飛ぶ (即死はしないがノイズ + 未定義状態)。

### 実装指示

- 3-B と同じ `MAX_LINE_BYTES` の強制フラッシュを適用 (共通ヘルパ化してよい:
  「chunk を受けて行単位に split し、上限超過は強制フラッシュする LineAssembler」を
  `src/log/` 配下に切り出し、file-tail / process-file / docker-tail で共用)。
- `stream.on('error', ...)` を追加して logger.warn に流す。
- spawn `'error'` 時の `tailers.delete` は WP2 2-C で対応済みの想定 (未実施なら
  ここで対応)。

## 3-D. error-detector の ReDoS ガード

### 対象

`src/log/error-detector.ts:54-57` (regex コンパイル)、`:95-110` (`onLine`)

### 現状の問題

`error_rules` テーブル由来の regex を `new RegExp(pattern, 'i')` でコンパイルし、
全サービスの**全ログ行**に `.test` (:103)。バックトラック爆発する pattern が 1 つ
登録されるだけで、ログストーム時にイベントループが CPU 100% で張り付く。

### 実装指示

1. 検査対象行に長さ上限: `line.line.slice(0, 4096)` に対して test する
   (ReDoS は入力長に対して指数的なので、入力を切るのが最も確実で安価)。
2. regex コンパイル時 (:54-57) に簡易バリデーション: pattern 長の上限 (例: 512 文字) を
   超えるものは reject して logger.warn。`(a+)+` 級の検出までは不要 (過剰実装しない)。
3. `onLine` 内の rule ループを try/catch で包み、1 rule の失敗が他 rule と
   検知処理全体を止めないようにする (現状の例外伝播経路を確認し、必要なら)。

### 受け入れ条件

- 4KB 超の行 + 悪性 pattern でも 1 行あたりの処理が実測で数 ms に収まる。
- 既存の検知ルール (`error_rules` seed) の検知結果が変わらない
  (先頭 4KB に収まる通常のエラーログで確認)。

## 対象外

- `vestigium-reader.ts` — 読み取りは 256KB 上限済みで安全。
- `sse.ts` の `llmCache` — キー空間が実質有界で、self-refresh も pending ガード済み。
- log bus → DB の INSERT バッチ化 → WP4。
