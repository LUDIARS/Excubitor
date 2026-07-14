# 不足機能レビュー — Excubitor v0.1

評価: **C**

spec `v0.1-design.md` §11 MVP チェックリストに対するカバレッジ。

## §11 MVP 対応表

| § | 要件 | 状態 |
|---|------|------|
| ① infra excubitor DB | ✅ |
| ② migrations v0.1 一式 | ✅ |
| ③ catalog 5+ サービス | ✅ (268 行) |
| ④ docker ps + health probe → UI | △ (health probe は未実装、 docker ps のみ) |
| ⑤ start/stop ボタン | ✅ |
| ⑥ autostart=true | △ (node / dev-process-md のみ、 docker-compose は skip) |
| ⑦ dev-process.md runtime | ✅ |
| ⑧ restart_policy / max_restart + error_task | ✅ |
| ⑨ node の Infisical inject | ✅ |
| ⑩ docker-compose の /dev/shm override inject | ❌ |
| ⑪ redacter で stdout secret マスク | ❌ |
| ⑫ inject:true 待機 → bootstrap 後 spawn | △ (skip するが bootstrap 完了 hook が無い) |
| ⑬ SSE log stream | ✅ |
| ⑭ error_rules regex マッチ | ✅ |
| ⑮ error_tasks 画面で ack/resolve | ✅ |
| ⑯ Infisical secret 一覧 + update | ✅ |
| ⑰ audit_log 記録 | △ (control/bootstrap/secret は記録、 error_task triage 無し) |
| ⑱ Cernere session login gate | ❌ |

達成 11 / 18 (60%)、 部分達成 4、 未達成 3。

## 設計外の不足

- **M-1 (high)** `liveness_history` テーブル (`migrations/001_initial.sql:54-64`) への INSERT 箇所が全コードに無い。 §11-④ の中核。
- **M-2 (high)** health endpoint polling 自体が scanner loop に無い (`src/scanner/loop.ts:23` は docker ps のみ)。 URL probe は `auto_fix/runner.ts:336-345` の verify 経路に閉じ込められている。
- **M-3 (medium)** Cernere session middleware / login UI 全体 (spec §9.1)。
- **M-4 (medium)** `GET /api/v1/audit` の API が spec §6 にあるが未実装。
- **M-5 (medium)** docker-compose secret inject (§11-⑩) は v0.1 では node runtime 限定の縮退モードと README 明記が必要。
- **M-6 (medium)** Web Push 通知 (Memoria のパターン流用可)。
- **M-7 (low)** `error_rules` の DELETE / PATCH API 無し (POST のみ、 `src/index.ts:554-573`)。
- **M-8 (low)** catalog reload 時に削除サービスの running process をどうするか未定義。
- **M-9 (low)** hosts テーブルへの自ホスト upsert (`service_instances.host_id` が常に NULL)。
- **M-10 (low)** PORT-MAP / infra services.yaml の整合性確認。

## 結論

MVP 達成率 60%。 「health probe + liveness_history」 の中核欠落が最大ギャップ。 §11-⑩ は重い設計なので v0.1.x で「縮退モード」 README 明記が現実解。
