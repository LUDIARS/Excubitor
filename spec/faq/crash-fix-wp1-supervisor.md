---
tags: [crash, service-runner, server, scanner]
date: 2026-07-09
kind: problem
---

# WP1: service-runner 道連れ shutdown 廃止 / ハンドラ内 throw 対策 / docker ps timeout

親資料: [crash-2026-07-analysis.md](crash-2026-07-analysis.md) の #1〜#4。
**最優先**。3 件とも修正は小さく、1 PR にまとめる。

## 1-A. service-runner を個別再起動スーパーバイザにする

### 対象

`src/service-runner.ts` (全 48 行)

### 現状の問題

```ts
child.on('exit', (code, signal) => {           // :24-27
  console.error(`[service-runner] ${name} exited ...`);
  shutdown(code ?? 1);                          // ← どちらの子でも全体を殺す
});
```

- backend (`dist/server.js --service`) と frontend (`npm run preview` :17333) のうち
  **どちらかが exit すると全体を SIGTERM + `process.exit`**。frontend のポート競合や
  一時エラーで健康な backend まで死に、外側の service manager が全体を再起動する。
  これが「Ex がよく落ちる」の最有力原因。
- `spawn` (:17) に `'error'` リスナーがない。`npm.cmd` が PATH に無い等の spawn 失敗は
  `'error'` イベントで飛び、リスナーなしで runner ごと即クラッシュ。
- runner 自体に `uncaughtException` / `unhandledRejection` ハンドラがない。

### 実装指示

1. 子ごとに**個別再起動**へ変更する:
   - `child.on('exit')` で全体 shutdown せず、その子だけ再 spawn する。
   - 再起動は指数バックオフ (初回 1s、倍々、上限 60s)。一定時間 (例: 5 分) 正常稼働
     したらバックオフをリセット。
   - shutdown 中 (`SIGINT`/`SIGTERM` 受信後) は再起動しない (現行の `shutdown()` は維持)。
2. 各 spawn に `child.on('error', ...)` を追加し、exit と同じ再起動パス (バックオフ付き)
   に流す。`'error'` 後に `'exit'` が来ない場合があるため、二重再起動しないよう
   settled ガードを付ける。
3. runner の先頭に `process.on('uncaughtException')` / `process.on('unhandledRejection')`
   を追加。console.error に書いて**継続** (server.ts と同じ log-and-continue 方針)。
   console 書き込み自体も try/catch で包む (下記 1-B と同じ理由)。
4. 再起動時のログは `[service-runner] restarting <name> attempt=<n> backoff=<ms>` の形式で
   console に出す (このファイルは pino 非依存のまま維持)。

### 受け入れ条件

- frontend の子を手動 kill しても backend プロセスが生き続け、frontend が
  バックオフ付きで再起動される (逆も同様)。
- 存在しないコマンドを spawn しても runner が落ちず、リトライがバックオフで継続する。
- SIGINT / SIGTERM で従来どおり全子を止めて終了する。

### テスト

`src/service-runner.ts` は現状テスト対象外の薄い entry。再起動ロジック (バックオフ計算・
settled ガード) を純粋関数 or 小さなクラスに切り出し、`src/service-runner.test.ts` で
fake timer + fake spawn によるユニットテストを書くこと。

## 1-B. クラッシュハンドラ内の `logger.error` を保護する

### 対象

`src/server.ts:43-55`

### 現状の問題

```ts
process.on('uncaughtException', (err) => {
  logger.error({ err: ... }, 'uncaught exception');   // :44 ← 裸
  writeDiagnostic('uncaughtException', { ... });       // こちらは内部で try/catch 済み
});
```

pino はトランスポートなし = fd 1 への同期書き込み。起動元コンソールが閉じられた場合
(Windows で頻出) 等に EPIPE で throw し、**`uncaughtException` ハンドラ内の throw は
Node では無条件 fatal** — log-and-continue 設計が丸ごと迂回される。
`unhandledRejection` ハンドラ (:50) も同様。

### 実装指示

- 両ハンドラ内の `logger.error(...)` を `try { ... } catch { /* noop */ }` で包む。
  `writeDiagnostic` が独立して残るよう、logger と diagnostic は別 try にする。
- 同様にハンドラ以外でも「死にかけの状況で呼ばれるログ」(`shutdownAndExit` 内、
  `server.on('error')` 内) は throw しても致命傷にならない位置か確認し、必要なら同様に保護。

### 受け入れ条件

- `logger.error` が throw するようモックしても、uncaughtException ハンドラが例外を
  漏らさず `writeDiagnostic` まで到達する (ユニットテストで確認)。

## 1-C. `execDocker` に timeout を付ける

### 対象

`src/scanner/docker.ts:41-54` (`execDocker`)

### 現状の問題

リポジトリ内で唯一 timeout タイマーのない spawn ヘルパ。`listContainers()` (:19) は
scanner tick の先頭で await されるため、docker daemon が固まる (Windows/WSL で頻出) と
tick が永久に完了せず、self-rescheduling の `setTimeout` に到達しない =
**死活監視・docker-tail 管理・health 同期がすべて沈黙停止**する。

### 実装指示

- `execDocker` を廃止し `src/shared/exec.ts` の `execCapture` (timeout 15s) に置き換える。
  WP2 で exec.ts に SIGKILL エスカレーションが入るため、共通化しておけば自動で恩恵を受ける。
- timeout / 失敗時は現行どおり「docker なし」として空リスト扱いにフォールバックし、
  scanner tick は継続すること (throw で tick を止めない)。
- timeout 発生時は `logger.warn` で 1 回記録 (毎 tick のスパム防止に、連続失敗中は
  初回のみ warn / 以降 debug などの抑制があると望ましい)。

### 受け入れ条件

- `docker` コマンドが応答しない状況 (モック) でも scanner tick が timeout 後に完了し、
  次 tick がスケジュールされる。

## 対象外 (このWPではやらない)

- exec.ts 自体の SIGKILL エスカレーション・出力上限 → WP2
- 起動時 `npm install` (`runStartupNpmInstallAndAudit`) の見直し — 再起動ループ時の
  回復を遅くする副次要因だが、クラッシュ原因ではないため任意の follow-up とする。
