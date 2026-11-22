# Excubitor 主スレッドの停止を減らす

## 背景 {#SPEC-EX-MAIN-THREAD-STALL}

2026-11-22 の実測で、Excubitor 本体 (`dist/server.js --service`) は約 20 時間に 90 回起動し直していた。
1 台の寿命は中央値 120 秒、起動は中央値 55 秒 (最長 170 秒)。原因は supervisor の健康監視
(`src/local-control/excubitor-backend.ts`、5 秒ごとに `/health` を 1 秒の時間切れで確かめ、3 回続けて
落ちたら SIGTERM) が、主スレッドの同期処理で `/health` に応えられない Excubitor を殺していたこと。

60 秒の CPU プロファイルでは主スレッドの約 65% が処理で埋まっていた。

| 原因 | 60 秒中 | 場所 |
|---|---|---|
| 子プロセスの起動 (git 等) | 8.7 秒 | `src/update/checker.ts` ほか |
| 鍵の導出 (scryptSync) | 5.2 秒 | `src/federation/store.ts` → `secret-box.ts` |
| カタログの同期走査 | 4.5 秒 | `src/catalog/fragments.ts` / `watcher.ts` |

本書の規則で、要求を捌けない長い同期処理を減らす。健康監視の閾値 (1 秒・3 回) は変えない。

## ピアの機密列を開き直さない {#SPEC-EX-PEER-SECRET-CACHE}

- `src/federation/opened-secret-cache.ts` の `createOpenedSecretCache` が、保存値 (暗号文) ごとに開いた
  結果を覚える。`src/federation/store.ts` の `rowToPeer` は token と CF secret をこれで開く。
- 連合の状態キャッシュ (`src/federation/payload-cache.ts`) が 10 秒ごとに `listPeers()` を呼んでも、
  保存値が変わらなければ scrypt を回さない。
- 保存値は暗号化のたびに salt が変わるので、値の更新・取り消しは新しい保存値として即座に効く。
- 復号できなかった結果 (null) も覚える。master 鍵はプロセス内で固定で、差し替えには再起動が要る。
- 件数は 256 件までで、古いものから捨てる。
- 起動時の移行 (`resealLegacyPeerSecrets`) は従来どおり `openSecretDetailed` で毎回開く。

## 更新確認の git 起動を絞る {#SPEC-EX-UPDATE-SPAWN-BUDGET}

- `src/update/checker.ts` の `checkAllUpdates` は同時に確かめるリポジトリを 2 件にする (従来 6 件)。
  1 サービスで git を 3〜4 本起動し、Windows では起動のたびに主スレッドが数十 ms 止まる。
- `src/update/router.ts` の一覧の保持時間 `EXCUBITOR_UPDATE_CACHE_MS` の既定を 5 分にする (従来 1 分)。
  明示の `fetch=1` と単一サービスの確認は従来どおりその場で取りに行く。

## カタログの定期確認を軽くする {#SPEC-EX-CATALOG-POLL-COST}

- `src/catalog/fragments.ts` は worktree と判定したディレクトリを覚え、次からは `.git` を stat しない。
  ARS_ROOT 直下は 2,088 件中 1,260 件が worktree だった。
- 「worktree でない」ことは覚えない。`git worktree add` の途中 (ディレクトリだけ先にできた瞬間) を
  通常リポと覚えると、その worktree の fragment を以後取り込んでしまうため。
- 一覧から消えたディレクトリは探索のたびに忘れる。root が 1 つでも読めなかった回は忘れない。
- `src/catalog/watcher.ts` の定期確認の既定間隔を 15 秒にする (従来 5 秒)。既存 fragment の変更は
  個別 watcher が即時に拾い、定期確認は追加・削除と通知欠落の救済に使う。

## 健康監視で殺した理由を残す {#SPEC-EX-HEALTH-KILL-LOG}

- `src/local-control/excubitor-backend.ts` の `checkOwnedHealth` は、連続失敗で殺す前に
  `onError` へ理由と pid を渡す。supervisor はこれを `excubitor-supervisor.log` に書く。
- 従来は起動し直すと `lastError` が消え、90 回の再起動が supervisor ログに 1 行も残らなかった。

## beforeExit を 1 回だけ記録する {#SPEC-EX-BEFORE-EXIT-ONCE}

- `src/shared/before-exit-report.ts` の `installBeforeExitReport` が `process.beforeExit` を最初の
  1 回だけ記録する。`src/server.ts` はこれを使う。
- 記録の非同期書き込み (pino) がイベントループに仕事を足し、書き終わるとまた beforeExit が来る。
  2026-11-22 には起動失敗の後 3 分で約 50 万回くり返し、診断ログが 2.4 GB に膨らみ、プロセスも終わらなかった。

## 受け入れ条件

- 同じ保存値は 1 回だけ開き、値が変わると開き直す。開けない値も 1 回で済む (`opened-secret-cache.test.ts`)。
- 後から `.git` ファイルができた worktree も取り込まない。消えた worktree の名前で作り直した通常リポは
  読む (`fragments.test.ts`)。
- 健康監視で殺すとき、理由と pid が `onError` に渡る (`excubitor-backend.test.ts`)。
- beforeExit を何度受けても記録は 1 回 (`before-exit-report.test.ts`)。

## 復旧

この変更の revert。`EXCUBITOR_UPDATE_CACHE_MS` は env で従来の 60000 に戻せる。
