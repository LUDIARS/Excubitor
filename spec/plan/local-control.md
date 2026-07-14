# Local control operations and test plan

## 1. 目的

Excubitor backend が停止していても、persistent local supervisor と `excubitorctl` から Ex 自身と
catalog service の status / start / stop / restart を実行できることを保証する。Web UI/API は
この local IPC contract の proxy であり、別の lifecycle implementation を持たない。

## 2. 通常運用

初回 build:

```powershell
npm install
npm run build
```

foreground/dev supervisor:

```powershell
npm run service
```

常設環境では Windows per-user scheduled task / systemd / launchd が、絶対パスの Node と
`dist/service-runner.js` を直接 main process として起動し、Ex backend より先に利用可能にする。
`npm run service` は foreground/dev 専用で、OS manager と Node の間に npm / PowerShell wrapper を挟まない。
custom service name は runner が検証する `--service-name=<name>` argv で渡す。supervisor の停止を
backend の stop 手段として代用しない。

別ターミナルからの操作:

```powershell
npm run ctl -- excubitor status --json
npm run ctl -- excubitor restart --json
npm run ctl -- service concordia status --json
npm run ctl -- service concordia restart --json
npm run ctl -- service concordia kill-port --port=17332 --json
```

package bin が PATH にある場合は先頭を `excubitorctl` に置き換えられる。`--json` の stdout は
機械可読 response 専用である。`ok: false`、non-zero exit、IPC 接続失敗を成功扱いにしない。

`start-excubitor.bat` は build 後に次を実行するだけである。

```text
npm run ctl -- excubitor start --json
```

mutating CLI は IPC が無い場合、導入済みの OS service manager に supervisor の起動を要求して
endpoint readiness を待つ。CLI の子として `dist/service-runner.js` を直接 background spawn しない。
Windows は同一アカウント・Limited 権限の per-user scheduled task、Linux は systemd user service、macOS は launchd を利用する。
未導入または起動失敗時は `scripts/install-service.ps1` / `scripts/install-service.sh`、あるいは開発時だけ
foreground の `npm run service` を案内し、同じ command を再実行する。

## 3. Web proxy 障害時

UI の lifecycle action は `/api/v1/services/:code/control` から local IPC へ中継される。エラー表示に
出る次の command を、対象ホストのリポジトリ root で実行する。

```text
npm run ctl -- service <code> <start|stop|restart|status> --json
```

`/api/v1/services/:code/emergency` も `kill-port` / `claude-port-fix` を同じ service target queue へ
proxyする。explicit emergency stop intent は pending auto-restart を取消してから実行する。

backend 自身を復旧する場合:

```text
npm run ctl -- excubitor status --json
npm run ctl -- excubitor start --json
```

backend 自身の Web `stop/restart` は二段階で行う。API は supervisor に operation を `prepare` して
HTTP 202 を返し、Node `ServerResponse` の `finish` 後に同じ operation ID を `commit` する。
supervisor は commit の IPC acknowledgement を書き終えてから実停止するため、HTTP 応答途中で
backend を落とさない。CLI は HTTP を介さないため 1 回の `execute` requestで実処理の
`completed` / `failed` まで待ち、その結果を exit code に反映する。

status CLI または OS service 起動要求後の mutating CLI も IPC 接続に失敗する場合は backend ではなく supervisor の障害である。backend の旧
in-process process manager へ切り替えず、supervisor の service/log/state を調査する。

## 4. Windows 安全条件

- supervisor は Ex backend の子として起動しない。常用環境では OS service manager を supervisor の owner とする。
- named pipe は Windows account + `EXCUBITOR_SERVICE_NAME` から導出した名前に分離し、all-user write
  permission は追加しない。installer 既定は同じ account の per-user scheduled task とする。
- Windows Service/NSSMはIntegrity Levelが通常CLIと異なるため、local-control ownerとしてサポートしない。
- Windows installer は同名の旧 Windows Service/NSSM を検出すると、既定では変更せず fail-fast する。
  elevated PowerShell で `-MigrateLegacyService` が明示された場合だけ、元の start mode/state を記録し、
  旧サービスを停止・無効化してから per-user task を起動する。旧サービス登録は削除しない。
- task の登録・起動に失敗した migration は旧 service と既存 task を rollback する。uninstall も既定では
  task のみを削除し、`-RestoreLegacyService` が明示された場合だけ保存済み状態へ戻す。
- 想定 threat model は単一の信頼済みユーザーが使う workstation である。相互に信頼しない複数ユーザーが
  同時利用する Windows host は対象外で、導入する場合は named-pipe SID ACL と peer identity 検証を追加する。
- 再採用サービスは PID + OS process creation time、Ex backend は PID + per-spawn instance token を照合してから停止する。
- image 名指定の kill、未検証 PID の `taskkill /T /F`、shell 文字列連結を禁止する。
- child command は executable / args / cwd / stdio を分離し、window を作らない。
- stdout/stderr は supervisor が所有する file descriptor へ接続し、backend 停止で EPIPE にしない。
- 同じ target の operation を直列化し、重複 operation ID は同じ結果を返すか明示的に拒否する。

## 5. 受入試験

### P0: lifecycle independence

1. Ex backend を停止し、`service <code> status/restart` が CLI から成功する。
2. Web API から `excubitor restart` を要求し、旧 backend PID の終了後に新 PID が ready になる。
3. supervisor を強制終了しても既存 backend/service が誤って道連れ終了しない。
4. supervisor 復旧後、既存 process を一度だけ再採用し、重複 spawn しない。
5. `start-excubitor.bat` は build failure / IPC failure を non-zero で返す。

### P0: safety and convergence

1. PID 再利用を模擬し、identity が異なる foreign process を停止しない。
2. start/stop/restart を CLI と API から同時送信し、target ごとに直列化される。
3. STOPPING / STARTING 中に supervisor を落とし、再起動後に persisted desired state へ収束する。
4. explicit stop が restart policy を発火させず、restart が二重 spawn にならない。
5. port を foreign process が占有した場合、その process を殺さず conflict を返す。

### P1: observability and packaging

1. backend restart 前後で stdout/stderr log が継続し、UI が復旧後に tail を再開する。
2. repo path に空白・非 ASCII があっても executable/args/cwd が崩れない。
3. repo の `dist` 更新中でも稼働中 supervisor が operation を完了する。
4. UI の停止・異常 service が非表示にならず、control error に実行可能な CLI fallback が出る。
5. relative Markdown link checker と frontend/backend build/typecheck を CI で実行する。

## 6. 最小確認コマンド

```powershell
npm run build
npm test
npm --prefix frontend run build
npm run ctl -- excubitor status --json
```

最後の command は supervisor が稼働している integration environment でのみ実行する。unit/CI で
supervisor を起動しない場合は、protocol/client/server の hermetic test を使用する。

## 7. Follow-up transaction boundaries

本変更の直列化単位は service / Excubitor の各 target である。複数serviceを跨ぐ launch batch、
update/install/build 全体、長時間auto-fix後の条件付きrestartは、今後 supervisor 側のbatch operationまたは
desired-state generationを使うcompare-and-setへ拡張する。個々の実lifecycle mutationがWeb backendを
迂回することはないが、これら複合workflow全体はまだ単一transactionではない。
