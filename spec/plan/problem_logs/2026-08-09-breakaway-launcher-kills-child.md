# breakaway launcher が spawn 直後に終了し、起動した子を道連れにしていた

- Date: 2026-08-09
- Status: fixed in working tree (`fix/breakaway-spawn-child-dies`)
- Area: process / breakaway spawn
- Severity: critical — Excubitor 経由で node ランタイムのサービスが 1 つも起動できなかった

## Summary

`concordia-control` を起動しようとすると必ず
`could not be verified after breakaway spawn (pid=N)` で失敗する、という報告から入った。
調べると単一サービスの問題ではなく、**Excubitor 経由でどのサービスも起動できない**状態
だった (`concordia-control` / `concordia-cost` / `genius` を実測)。

原因は §17.4 で導入した短命 launcher にある。launcher は `spawn` イベントを受けたら
`unref()` して結果ファイルを書き、**即座に終了**していた。`spawn` は `CreateProcess` の
成功にすぎず子の実行開始を意味しないため、launcher の即時終了によって子が起動に入る前に
消えていた。

## Evidence

計測日 2026-08-09。

### 症状

`excubitorctl service <code> start` / Web API のどちらからでも同形で失敗する。

```
service concordia-control could not be verified after breakaway spawn (pid=26660);
it exited immediately or its identity was unreadable
```

- `data/process-logs/concordia-control.{out,err}.log` は 0 バイトのまま。
- spawn 中に `data/process-logs/.breakaway-*.json` を監視すると `{"pid":N}` が書かれている。
  つまり launcher の `child.once('spawn')` は発火しており `error` は出ていない (ENOENT ではない)。
- 25 秒間・100ms 間隔で `Win32_Process` を走査しても、その子プロセスは一度も現れない。
- 同じコマンドを手動実行すると正常に起動する。

### 切り分け

段階的に外して、WMI も Excubitor のコードも無関係だと分かった。

| 経路 | 結果 |
|---|---|
| 手動実行 (`node dist/control-worker.js`) | 起動する |
| WMI Create → `cmd /c <bat>` → `whoami` / `node -v` | 起動する |
| WMI Create → 自作 spawner (200ms 待って exit) → node | 起動する |
| **launcher (WMI 無し・普通の子プロセスとして実行) → node** | **起動しない** |

launcher だけが再現するので、WMI / Job / 環境変数ではなく launcher のコードが原因。

### 最小再現

同一の `spawn` を、終了タイミングだけ変えた親から行う:

```
親が spawn 直後に process.exit(0)     → 子は痕跡を残さず消える (marker 無し / 出力無し)
親が 300ms 待って process.exit(0)     → 子は正常に動く (marker あり / stdout あり)
```

cmd.exe を入口にする子は前者でも生き残るため、症状は「node だけ起動できない」ように見える。

## Regression Context

§17.4 (2026-08-08, `a56035d`) で「起動をコマンドラインで永続化せず短命 launcher へ移す」
変更を入れた際に混入した。launcher の設計目標が「実 pid を返したら**即座に終了**する」
だったため、`spawn` イベント = 起動完了という前提がそのままコードになっていた。

紛らわしいのは、失敗の見た目が §17.4 が直したはずの症状 (無出力で即死 →
`could not be verified after breakaway spawn`) と完全に同じことで、
「修正が反映されていないのでは」と誤診しやすい。実際に一度その方向で結論を出しかけた。

## Cause

`launchBreakawayChild` が `child.once('spawn')` の直後に `unref()` → 結果書き込み →
`return` していた。`spawn` は `CreateProcess` の成功を意味するだけで、子が実行に入ったことは
意味しない。launcher プロセスが消えると、まだ起動途中の子も失われる。

## Fix

満たすべき不変条件は「**子プロセスが Excubitor 側の寿命に巻き込まれないこと**」と
「**supervisor 再起動時に切り離された子を見つけられること**」。待ち時間で緩和するのでは
足りないので、経路ごとに構造で満たす。

### 1. `shell` を挟まない起動 → `detached: true`

runtime=node の `command` 直起動と runtime=app の `exec` は `detached: true` で
構造的に切り離す。launcher が即終了しても子は残り、launcher が開いたログ fd も効く。
待ちは不要。

| 実測 | 子の生存 | stdout |
|---|---|---|
| shell 無し / detached 無し | 消える | — |
| **shell 無し / detached あり** | **残る** | **取れる** |

### 2. `shell` 経由 → 起動猶予を待つ

`npm` / `.bat` を入口にするサービスは `detached` を付けられない。DETACHED_PROCESS の
cmd.exe はコンソールを持たず、その子へ std ハンドルを渡せなくなるため **ログが落ちる**。

| 実測 | 子の生存 | stdout |
|---|---|---|
| shell あり / detached 無し | 消える | — |
| shell あり / detached あり | 残る | **空になる** |
| **shell あり / detached 無し + 起動猶予** | **残る** | **取れる** |

そこで `spawn` 後 `CHILD_SETTLE_TIMEOUT_MS` (既定 750ms) だけ `process.kill(pid, 0)` で
生存を見張ってから結果を書く (`awaitChildStartup`)。

- 子が既に終了していれば待ち切らずに抜ける (短命コマンドで無駄に待たない)。
- 「消えた = 失敗」とは扱わない。正常終了と起動前の消失は pid の生死だけでは区別できず、
  その判定は §17.3 の identity 照合が持つ。
- 待ち時間は supervisor 側の結果待ち (既定 20s) に対して十分短い。

### 3. 再発見 (既存の仕組みで満たされている)

`spawnOutsideJob` が返すのは実プロセスの pid で、`updateInstanceStatus` が spawn 直後に
永続化する。supervisor 再起動時は `reconcile.ts` が永続 pid + 起動時刻の identity 照合で
生存プロセスを再採用する (PID 再利用は照合で弾く)。子は Job 外に残るため
`detached` の有無にかかわらず見つかる。今回の変更で壊れていないことを確認した。

## Verification

- `src/process/breakaway-launcher.test.ts` — 12 tests pass。
  - `detaches the child instead of waiting when no shell is involved`
    (shell 無しでは待たない = 構造で切り離せている)。
  - `does not return before a shell-launched child has had time to start` が
    shell 経路の回帰本体 (結果を書く前に猶予を待ち切る)。
  - `awaitChildStartup` の待ち切り / 早期終了を個別に確認。
- 実起動 (build 後、launcher を直接叩いて長命 node スクリプトを起動):

  | 経路 | launcher の所要 | 子の生存 | stdout |
  |---|---|---|---|
  | shell 無し | 219ms | 生存 | `alive noshell` |
  | shell あり | 1065ms | 生存 | `alive shell` |

  修正前は同じ手順で marker も出力も残らなかった。shell 無しが待たずに済んでいることも
  所要時間で確認できる。

## 反映後の実測 (2026-08-09、supervisor 再起動後)

`dist/service-runner.js` を Scheduled Task ごと再起動して §17.4.1 を載せた結果:

- **子は死ななくなった。** `concordia-control` の worker が実際に起動する
  (`control worker started` がログに出る)。
- **停止キューが流れた。** `control_jobs` の `queued` 715 → **0**。
  755 件は期限切れで `failed`、**14 件は stop_process_tree が実行された**。
- **切り離された子の再採用が効いた。** supervisor を止めて起こし直しても
  cernere / concordia / memoria-server / ludellus-web / revisor は `running` のまま。
- **稼働中セッションを巻き添えにしていない。** active/lost セッションは 14 → 13。

ただし `concordia-control` の state は `crashed` のまま残った。**pid 契約の破れ**
(返り pid が cmd.exe) が別に存在したため。これは §17.4.2 で対処した。

## Follow-up

- 反映には supervisor (`dist/service-runner.js`) の再起動が必要
  (`src/process/` は supervisor 内で動く)。
- 反映後に `concordia-control` / `concordia-cost` / `genius` を起動し直す。
  停止キューの滞留については Concordia 側
  `spec/plan/problem_logs/2026-08-09-control-worker-crashed-stop-queue-stalled.md` を参照。
- 「Excubitor 経由の起動が全滅している」ことに誰も気づけなかった。`start` が失敗し続けて
  いること自体を通知する経路が無く、個々のサービスは「stopped だから止めてあるのだろう」と
  読めてしまう。
