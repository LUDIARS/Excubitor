---
tags: [crash, exec, child-process, auto_fix, process-manager]
date: 2026-07-09
kind: problem
---

# WP2: 子プロセス管理の共通化 (SIGKILL エスカレーション / 出力上限 / auto_fix 統一)

親資料: [crash-2026-07-analysis.md](crash-2026-07-analysis.md) の #5〜#8。
テーマは 1 つ: **spawn した子を確実に回収し、出力でヒープを食い潰さない**。1 PR。

## 2-A. `shared/exec.ts` に SIGKILL エスカレーションと出力上限を実装

### 対象

`src/shared/exec.ts` (`execCapture` / `safeExec`) — 全サブシステムの共通ヘルパ。

### 現状の問題

```ts
const timer = setTimeout(() => {
  try { proc.kill('SIGTERM'); } catch { /* noop */ }   // :46 ← TERM 止まり
  finish({ ok: false, ... });                           // :47 ← 即 resolve (子は放置)
}, timeoutMs);
proc.stdout.on('data', (c) => (stdout += c.toString('utf8')));  // :49 ← 無制限蓄積
```

1. timeout 時に SIGTERM を送るだけで即 resolve。SIGTERM を無視する子
   (docker / wsl.exe / cmd 系 health コマンドで典型的) は生き残り、stdout/stderr の
   pipe fd を親側で握ったまま累積する。scanner は 10 秒ごとにサービス数比例で子を
   fan-out するため、遅いマシンでは毎 tick リーク → EMFILE / spawn 失敗 → プロセス死。
2. stdout/stderr の蓄積に上限がない。大量出力でヒープ上限 abort (uncaughtException では
   捕捉不能)。特に `process/build.ts` (timeout 30 分, shell 経由) と auto_fix の
   Claude CLI (10 分) が高リスク。

### 実装指示

1. timeout 時のエスカレーション:
   - SIGTERM 送信 → 猶予 (例: 5s) 後にまだ `close` していなければ `SIGKILL`。
     Windows では SIGTERM が実質 kill だが、同じコードパスで問題ない。
   - shell 経由 (`needsShell`) の場合は子の子が残るため、可能なら
     `detached` + プロセスグループ kill (unix) / `taskkill /T /F` (win) を検討。
     過剰に複雑になるなら SIGKILL 直接送付までで可 (方針をコードコメントに残す)。
   - promise の resolve は現行どおり timeout 時点でよい (呼び出し元をブロックしない) が、
     kill エスカレーションは resolve 後も裏で完走させる。
2. 出力上限:
   - `execCapture` にオプション `maxOutputBytes` (既定 4MB 程度) を追加。
     超過分は捨て、`stdout` 末尾に `\n[truncated]` を付けて示す。上限到達後は
     `data` を蓄積しない (リスナーは付けたまま読み捨てて、パイプ詰まりを防ぐ)。
3. 同型コードの統一:
   - 以下は exec.ts と同じ「SIGTERM 止まり + 無制限蓄積」パターンの複製。可能な限り
     `execCapture` 呼び出しに置き換え、置き換え困難なら同じエスカレーション+上限を実装:
     - `src/scanner/git.ts:47-50` 付近 (`safeExec` ローカル版が残っていれば)
     - `src/memory/process-sampler.ts:214-217` 付近
     - `src/memory/wsl-sampler.ts:173-176` 付近
     - `src/memory/docker-sampler.ts:90-93` 付近
     - `src/control/docker-compose.ts:63-65` 付近 (こちらは timeout 自体もない — 追加する)

### 受け入れ条件

- SIGTERM を無視する子 (テストでは `trap '' TERM` 相当のスクリプト or ダミー) が
  timeout 後 猶予以内に SIGKILL で回収され、`close` まで到達する。
- 上限超過する出力を流しても蓄積が `maxOutputBytes` で頭打ちになり、結果に
  truncated マークが付く。
- 既存の呼び出し元 (scanner / memory / update / control) の挙動が変わらない
  (成功パスの戻り値互換)。

## 2-B. auto_fix のローカル `execCapture` を廃止

### 対象

- `src/auto_fix/runner.ts:309-326` (ローカル `execCapture`) と呼び出し元
  (`git push` :140、`gh pr create` :148 など)
- `src/auto_fix/investigate.ts:181-198` (同型の複製)

### 現状の問題

ローカル版は timeout なし・`'error'` ハンドラのみ・stdin が pipe のまま未クローズ。
`git push` / `gh pr create` は認証プロンプトで永久ブロックしうるネットワーク操作で、
ハングすると子 + pipe 3 本がリークし、`inFlight` ロック (runner.ts:38) が永久保持され
そのサービスの auto_fix が二度と動かなくなる。

### 実装指示

1. ローカル `execCapture` を両ファイルから削除し、`shared/exec.ts` の `execCapture`
   (2-A 改修後) に統一する。
2. timeout はコマンド種別で設定: git ローカル操作 30s / `git push`・`gh` 120s。
3. stdin は閉じる: `shared/exec.ts` の spawn を `stdio: ['ignore', 'pipe', 'pipe']` に
   する (現行の既定 pipe で stdin を使っているのは Claude CLI の prompt 渡しのみなので、
   `stdin: 'pipe'` をオプトインオプションにする)。
4. Claude CLI spawn (`runner.ts:247-259` / `investigate.ts:162-174`) の
   `proc.stdin.end(prompt)` は、stdin stream に `'error'` リスナーを付けて EPIPE を
   握りつぶす (現行の同期 try/catch では非同期 EPIPE を捕まえられない)。

### 受け入れ条件

- `git push` がハングするモック環境で、timeout 後に `inFlight` が解放され、
  次の auto_fix 実行がブロックされない。
- claude CLI が即死するモックで EPIPE が uncaughtException に漏れない。

## 2-C. process/manager の spawn `'error'` 時クリーンアップ

### 対象

`src/process/manager.ts:150` (spawn 前の `startProcessLog`)、`:198-210`
(`child.on('exit')` / `child.on('error')`)

### 現状の問題

fd 2 本 (`data/process-logs/<code>.{out,err}.log`) + 1s tail interval + `processes`
エントリのクリーンアップが `child.on('exit')` にのみ配線されている。spawn `'error'`
(runtime=app で exec パス不正等) では `'exit'` が来ないため、これらが永久リークし、
サービスは「起動中」のまま wedge (再起動も `killService` も効かない)。

### 実装指示

- `'error'` ハンドラ (:208-210) でも `'exit'` と同じクリーンアップ
  (`stopProcessLog` + `processes.delete` + 状態記録) を行う。二重実行ガードを付ける
  (`'error'` の後に `'exit'` が来るケースがある)。
- あわせて `src/log/docker-tail.ts:44-46` も同じパターン: spawn `'error'` 時に
  `tailers.delete(serviceCode)` されず `isTailingService` が true のまま再試行不能に
  wedge する。`'error'` ハンドラで delete を追加する (こちらは WP3 と重なるが、
  同一パターンなのでこの WP で対応してよい)。

### 受け入れ条件

- 存在しない exec パスのサービスを起動しても fd / interval がリークせず
  (`stopProcessLog` 到達をテストで確認)、再度 start できる。

## 対象外

- `update/checker.ts` / `apply.ts` — 既に timeout・overlap ガード・CONCURRENCY 制限あり。
  2-A の exec.ts 改修の恩恵を自動で受けるのみ。
- restart_policy のロジック — backoff + max_restart 制限済みで安全。
  (`restartCount` が長期稼働でリセットされない可用性バグは別 issue として任意。)
