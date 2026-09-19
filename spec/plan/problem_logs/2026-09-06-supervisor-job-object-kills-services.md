---
tags: [crash, service-runner, supervisor, job-object, breakaway, spawn-strategy, concordia, revisor]
date: 2026-09-06
kind: problem
---

# supervisor 死亡で Concordia / Revisor が道連れになる (spawn したサービスが独立プロセスになっていない)

- Date: 2026-09-06
- Status: 一次原因は修正済み (2026-09-19、design.md §17.6)。Fix Requirements 2〜5 は unresolved
- Area: local-control / service-runner / breakaway spawn / process lifecycle
- Severity: critical — Ex の単一障害が Cc・Rv を同時に落とし、全 Claude セッションが停止する

## Summary

**これは回帰である。** 契約は「Ex が起動するサービスはすべて独立プロセスである」。
実際には spawn したサービスが supervisor と同一 Job Object に属しており、
supervisor が死ぬと OS によって道連れで強制終了される。
(2026-09-19 訂正: その Job は Scheduled Task のものではなく、supervisor の node (libuv) が
`detached` なしの子を入れる Job だった。下記「機構の訂正」)

2026-09-06 16:51、Ex supervisor (pid 32984) が未捕捉例外で死亡し、その 172ms 後に
Concordia (11111) と Revisor (4240) が同時に消滅した。Cc 側には一切の異常が無く、
死の直前まで `GET /health status=200 duration_ms=0` を返し Discord と delegation を
正常処理していた。シャットダウンログも例外も無く、ログが文の途中で途切れている。

ユーザから見た症状は「Cc が落ちた」だが、Cc に原因は無い。さらに深刻なのは、
`harness-gate` hook が fail-closed のため **全 Claude セッションの Bash / Edit / Write が
即座に全滅**したことである。`echo` すら実行できなくなり、自力復旧もできない。
Ex の単一障害がワークスペース全体を停止させる。

一方 Ludellus-Server / Quaestor / Interpres は生存した。これらは Ex の子ではなく
独立起動だったためで、「Ex 経由で起動したものだけが死ぬ」ことの対照実験になっている。

## Evidence

### 時系列 (すべて 2026-09-06 UTC)

    07:50:48.431  Ex backend pid 2476 が file-tail 41 本を開いて以降ログが途絶
                  ("Excubitor server listening" に到達していない = listen 前にハング)
    07:51:15.261  Excubitor backend health readiness timed out after 30000ms: fetch failed
    07:51:26.286  failed to signal Excubitor backend pid=2476   ← 以降 10 回連続
    07:51:35.369  Error: Excubitor backend did not exit within 10000ms  ← 未捕捉で supervisor 死亡
    07:51:35.541  Concordia の最後のログ                        ← わずか 172ms 後

正常起動時は `{"name":"excubitor.server","port":17332,"msg":"Excubitor server listening"}`
が必ず出る (直前の pid 19524 では出ていた)。pid 2476 では 41 行で途絶。

### Cc は最後まで正常だった

死の直前 109 行に **エラー・例外・シャットダウン記録が 1 件も無い**。

    07:50:48.339  http  request GET /health status=200 duration_ms=0
    07:51:16.272  delegation/service  delegation invoke received
    07:51:35.541  (ログが途中で途絶)

`shutting down` / `graceful` / `SIGTERM` / `server closed` を全ログから検索して 0 件。
stderr は Discord の `ephemeral` 非推奨警告のみでスタックトレース無し。

### Job Object 所属の実測 (復旧後 2026-09-06)

復旧後の稼働中プロセスで `IsProcessInJob` を実行:

    10608 (Concordia dist/server.js)    : inJob=True
    33960 (supervisor service-runner.js): inJob=True

親子関係も直結していた:

    10608  ppid=33960   node dist/server.js          ← Concordia
    33960  ppid=33364   node dist/service-runner.js  ← supervisor
    33364  ppid=18368   nohup.exe

Concordia は supervisor の **直接の子** であり、かつ **同一 Job Object 内**。
breakaway-launcher を経由していない。Windows は Job Object に
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` が付く場合、最後のハンドルが閉じた時点で
Job 内の全プロセスを強制終了する。これが 172ms の同時死の機構である。
(2026-09-19 訂正: KILL_ON_JOB_CLOSE の Job は Task のものではなく、supervisor の node (libuv) が
`detached` なしの子のために作ったもの。ハンドルを持つのは supervisor だけなので、supervisor の死と
同時に閉じる。9/6 は Task の停止ではなく supervisor の未捕捉例外による終了だったが、それでも
同時死したことと整合する)

### 契約と実装の乖離

`catalog` 上 Concordia は shell を経由しない素の node である:

    - code: concordia
      runtime: node
      command: node dist/server.js

`src/process/breakaway-launcher.ts:164` は `detached: !spec.shell` であり、
この経路なら `detached: true` が付いて構造的に切り離されるはずだった。
しかし実測の ppid は supervisor 直下であり、**この経路を通っていない**。
launcher を経由しない spawn 経路が別に存在し、そちらが detach も breakaway も
していないと考えられる。

なお `breakaway-launcher.ts:20` のコメントは

    Windows は親の終了で子を道連れにしないため、detached は付けない

と述べるが、これは **Job Object が無い場合にのみ真** である。Scheduled Task や
一部の起動経路は Job を作るため、この前提自体が条件付きでしか成立しない。

## 再発 (2026-09-19) — 回帰
2026-09-19 16:53:06 (JST)、外部 fragment の catalog trust を反映するために supervisor を
`Stop-ScheduledTask` → `Start-ScheduledTask` で入れ替えた。今回は supervisor の異常終了ではなく
**意図した再起動**だが、同じ機構で配下サービスが同時に消えた。

### 時系列 (2026-09-19 JST)

    16:44:15  actio が単独で終了 (未処理の read ECONNRESET。本件とは別の障害)
    16:49:06  actio-web / elegantia / 外部 fragment の Web サービスの最後の healthy probe
    16:52:47  revisor 旧 pid 75564 の最後の heartbeat (30s 間隔。次の 16:53:17 は出ていない)
    16:53:06  supervisor 再起動 (Task LastRunTime 16:53:06、新 supervisor pid 63092)
              memoria-server: `previous run ended 2026-09-19T07:53:06.928Z`
    16:53:24  revisor 新 pid 42868 (autostart)
    16:53:31  concordia を supervisor-auto-launch が spawn (新 pid 30028)
    16:53:34  memoria-server / concordia-cost を spawn、16:53:57 praeforma を spawn
    16:54:20  actio-web / elegantia / 外部 fragment の Web サービスが down 判定 (autostart 外は戻らない)

- 落ちた側の err.log は空。ログを書く間もなく OS に終了させられている。
- 生き残ったのは Ludellus-Server / Quaestor (親は既に死んだ launcher = Job 外で起動済み) と、
  Ex 外で手動起動された Anatomia だけ。9/6 と同じ「Ex 経由の child 起動だけが死ぬ」形。
- autostart 対象は数十秒で新 pid に置き換わったため「Cc はそのまま残った」と誤認されやすい。
  audit_log の `supervisor-auto-launch` による `spawn node:concordia` が再 spawn の証拠。

### 実測 (2026-09-19 再起動後)

    supervisor 63092 (dist/service-runner.js)  inJob=True   ppid=svchost (Task Scheduler)
    concordia   5984                           inJob=True   ppid=63092
    figmentum-audio-web 41604                  inJob=True   ppid=63092

    HKCU\Environment:  EXCUBITOR_SPAWN_STRATEGY = child

同時刻に `dist/process/breakaway-spawn.js` の `spawnOutsideJob` を無害な `node -e setTimeout` で
3 回試行し、3 回とも成功 (0.8〜1.1s)、生成プロセスは 3 つとも `inJob=False`。job-breakaway 経路は動く。

### 機構の訂正 (2026-09-19 実測)

本記録は当初「Scheduled Task の Job ごと終了した」としていたが、正しくは次のとおり。
Windows の Node (libuv) は `detached` なしで起動した子を、親だけがハンドルを持つ
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` の Job に入れる。親が終了するとハンドルが閉じ、子は OS に一斉終了させられる。

- 反映のための 1 回目の supervisor 再起動 (2026-09-19 18:36) で、旧 supervisor の直接の子だった
  Ex backend (`detached: true` で起動) は `Stop-ScheduledTask` を生き延びた。
- 使い捨ての親 node から `detached` なし / ありの子を 1 つずつ起動し、親だけを `taskkill /F`
  (`/T` なし) で終了すると、`detached` なしの子だけが消え、`detached` の子は残った。
- 旧 child 戦略は design.md §15.1 により win32 でだけ `detached` を外していた。そのため
  supervisor が終わる理由 (Task の停止 / 未捕捉例外) を問わず、配下が一斉に消えた。
- 上の `inJob=True` の実測は根拠にならない。`IsProcessInJob(h, NULL)` は「どれかの Job に属するか」
  しか返さず、`detached` なしの子を 1 つでも起動した node は自分自身も True になる (実測)。

修正後の検証: 反映後に autostart 外のサービスを起動し直し、18:39 に supervisor をもう一度再起動した。
稼働中の全サービス (17) の pid と health は前後で変わらなかった。

## Regression Context

同一クラスの障害が過去に 3 回記録され、いずれも未完了である。

- **`spec/faq/crash-fix-wp1-supervisor.md` (2026-07-09)** — 表題が
  「service-runner **道連れ** shutdown 廃止 / ハンドラ内 throw 対策」。
  「どちらの子でも全体を殺す」「runner 自体に `uncaughtException` /
  `unhandledRejection` ハンドラがない」と明記され **最優先** とされたが、
  2026-09-06 時点で両方とも未修正のまま今回の障害を起こした。
- **`2026-08-09-breakaway-launcher-kills-child.md`** — launcher の即終了で子が失われる
  障害。shell 経路に 750ms の起動猶予を導入した。
- **`2026-08-10-breakaway-launcher-process-ownership.md`** (status: unresolved) —
  cmd.exe 経由で PID がラッパーに留まり所有権を証明できない障害。
  「stdout/stderr の pipe や cmd.exe を存続させることを、プロセス所有権の代替に
  してはならない」と結論している。

つまり **プロセス独立性は 2 か月にわたり繰り返し要求されながら、一度も
構造的に保証されていない**。今回は「launcher を通れば detach される」設計だったが、
launcher を通らない経路が残っていたために破れた。

## Cause

二次的原因 (supervisor が死んだ理由) と一次的原因 (死が伝播した理由) を分ける。

### 一次: サービスが supervisor の寿命に構造的に依存している (本質)

spawn 経路が Job Object からの breakaway を保証していない。`detached: true` と
`unref()` は **Job Object に対しては無力** であり、切り離しには
`CREATE_BREAKAWAY_FROM_JOB` (かつ Job 側が `JOB_OBJECT_LIMIT_BREAKAWAY_OK` を許可)
が必要になる。現状はどちらの保証も無い。
(2026-09-19 訂正: 今回の全滅に効いたのは逆に `detached` の有無だった。`detached` なしの子は
libuv の Job に入り、親の終了で消える。`detached: true` の子は supervisor の終了も Task の停止も
生き延びた。「機構の訂正」参照)

加えて、実測された Concordia の ppid が supervisor 直下であることから、
**breakaway-launcher を経由しない spawn 経路が存在する**。契約を守る経路と
守らない経路が併存しており、後者が使われている。

**経路の正体 (2026-09-19 確定)**: ユーザ環境変数 `EXCUBITOR_SPAWN_STRATEGY=child`。
`src/process/manager.ts` の `resolveSpawnStrategy()` はこの値があれば win32 でも `child` を返し、
supervisor の直接の子として `detached` なしで `child_process.spawn` する (= libuv の Job 内)。コードに別経路があったのではなく、
**設定による上書きが breakaway を黙って無効にしていた**。audit_log の breakaway 失敗記録は
2026-08-12 (照合予算不足による `could not be verified` / `timed out after 20000ms`) が最後で、
その回避策として設定され、4078bb8 (照合予算 10s) で原因が直った後も残ったと推定される
(設定した記録は spec / memory に無い)。

### 二次: supervisor が子の停止失敗で自死する

`src/local-control/excubitor-backend.ts` の `terminateChild()` 呼び出し 4 箇所のうち、
**184 行目 (start パス) だけ try/catch が無い**。他の 3 箇所 (259 / 311 / 606) は
すべて catch して `scheduleRestart()` に落としている。

    // :184  ← 素通しで throw が上がる
    await this.terminateChild(this.child);

`terminateChild()` は `child.kill('SIGTERM')` が false を返すと throw し、
`waitForExit()` は 10 秒で reject する。今回はこの reject が上まで到達した。

さらに `service-runner` / `local-control` に `uncaughtException` /
`unhandledRejection` ハンドラが無いため、throw がそのままプロセス終了になる。
これは WP1 (2026-07-09) が指摘済みの未修正項目である。

### なぜ pid 2476 が listen 前にハングしたか (未解明)

file-tail 41 本を開いた直後に停止しており、この時点が最後のログ。
`dockerd` 不在 (Rancher Desktop 停止) による scanner の待ちが疑われるが、
warn で流れているため確定していない。**別途調査が必要。**

## Fix Requirements

優先度順。1 が本質で、2 以降は多層防御。

1. **すべての spawn 経路で Job Object からの breakaway を保証する。** — **対応済み (2026-09-19)**
   - 経路は `EXCUBITOR_SPAWN_STRATEGY=child` の上書きだった。win32 で child 起動を選ぶ手段を
     env ごと削除し、判定を `src/process/spawn-strategy.ts` の `spawnsOutsideJob()` に一本化した
     (win32 は常に job-breakaway)。残った env は読まず、1 回だけ warn する。ユーザ環境変数も削除済み。
   - Concordia が supervisor の直接の子になっている経路を特定し、
     breakaway-launcher に一本化する (launcher を通らない spawn 経路を残さない)。
   - Windows では `detached: true` だけでは不十分。Job 所属時は
     `CREATE_BREAKAWAY_FROM_JOB` を用いるか、supervisor 自身が
     `JOB_OBJECT_LIMIT_BREAKAWAY_OK` を持つ Job を作って子を入れる。
     (2026-09-19 訂正: 実測では `detached: true` の子は supervisor の終了と Task の停止を生き延びた。
     現行の job-breakaway は WMI で Task の Job を出たうえで `detached` で起動するので、どちらも満たす)
   - `breakaway-launcher.ts:20` の「Windows は親の終了で子を道連れにしない」という
     コメントは条件付きでしか成立しないため、記述を訂正する。— 対応済み (Job に属さない場合に限ると明記)
2. **`excubitor-backend.ts:184` の `terminateChild()` を try/catch で包む。**
   他 3 箇所と同様に `state='crashed'` + `scheduleRestart()` へ落とし、
   子の停止失敗が supervisor の死に直結しないようにする。
3. **`service-runner` / `local-control` に `uncaughtException` /
   `unhandledRejection` ハンドラを追加する** (WP1 1-A の積み残し)。
   ログを残して該当サービスのみ再起動し、supervisor 本体は生存させる。
4. **`terminateChild()` の Windows 経路を強化する。**
   `child.kill()` が false のときは `taskkill /PID <pid> /T /F` へフォールバックする
   (748 行に既存実装があるので流用可能)。今回は SIGTERM が 10 回失敗し続けた。
5. **harness-gate の fail-closed を見直す。**
   Ex 単一障害で全セッションの Bash / Edit / Write が同時に停止し、自力復旧も
   不可能になった。復旧操作だけは通す degraded モード、または明示的な
   bypass 手順の整備を検討する (`CONCORDIA_HARNESS_HOOKS=0` は事前に
   知っていないと使えない)。

## Verification

回帰を捕捉するテストは以下。**本項は要件の記録であり、実行はユーザ指示または
Revisor の plan に従う。**

- **経路判定テスト (2026-09-19 追加)**: `src/process/spawn-strategy.test.ts` が
  「win32 は常に Job 外」「`EXCUBITOR_SPAWN_STRATEGY=child` が残っていても win32 で child に
  戻らない」「残骸の warn は 1 回だけ」を固定する。`manager.test.ts` は判定だけを mock し、
  どの OS でも child / job-breakaway 両方のライフサイクルを検証する。
  これは 9/6 時点で書けていれば今回の再発を防げたテストである (上書きが効くこと自体を
  テストしていたため、上書きが本番に残る危険を検出できなかった)。
- **独立性テスト (最重要)**: supervisor 経由でサービスを起動し、supervisor を
  `SIGKILL` 相当で強制終了した後もサービスの health が応答し続けることを検証する。
  Windows では `IsProcessInJob` で子が supervisor と同一 Job に属さないことを
  直接アサートする。`dist/local-control/excubitor-backend.test.js:19` の
  `preserves a running detached backend when only the supervisor shuts down` は
  backend のみを対象としており、**catalog サービス (Cc / Rv) を対象にしていない**
  ため今回の障害を検出できなかった。同等のケースをサービス側へ拡張する。
- **catch 漏れテスト**: `terminateChild()` が throw する状況 (kill が false を返す
  モック) で start パスを実行し、supervisor が生存して `scheduleRestart()` に
  遷移することを検証する。
- **ハンドラテスト**: `unhandledRejection` 発生時に supervisor が終了しないこと。

## Follow-up

- pid 2476 が listen 前にハングした原因の特定 (別障害。dockerd 不在との関連を確認)。
- 死の直前に `ws session claim rejected: invalid enrollment` が 1 秒間隔で 47 回連続
  していた。今回の死因ではないが、再接続ループとして別途調査する。
- `runtime: python` が enum 不正のため 3 サービスがカタログから恒常的に無視されている
  (`interpres-worldpos` / `ludellus-capture` / `ostiarius-face-sidecar`)。
  これらは Ex の管理外にあり、監視されていない。
- 復旧後に `orbis` / 外部 fragment の Unity Editor サービスが crashed、`satelles` が unknown。
- 今回の復旧は `node dist/service-runner.js` の手動起動のみで、**再発防止の
  コード修正は一切入っていない**。Ex が転べば Cc と Rv は毎回道連れになる。
- **2026-09-19 の反映手順**: 修正を main に入れて build した後、supervisor を 1 回だけ
  再起動する (spawn は supervisor 側のコード)。その瞬間は Job 内に残っている既存サービスが
  最後の巻き添えになるので、autostart 外のサービス (Web 系) を起動し直す。以後に起動した
  サービスは `IsProcessInJob=False` になることを確認する。
