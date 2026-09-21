---
task: federation-mesh-deploy
project: Excubitor
kind: テスト
created: 2026-09-21
memory_links:
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/feedback-excubitor-restart-via-ctl.md
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/project-excubitor-local-control-plane.md
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/feedback-shared-infra-lifecycle-not-my-call.md
---
# 拠点メッシュ + 監視ループ軽量化 (#1943) を稼働中の Excubitor へ反映して確かめる

## 目的

Revisor local PR #1943 (main 797d4fa) は main に入ったが、稼働中の Excubitor は旧コードのまま。
build と Excubitor の再起動で反映し、監視ループが実際に軽くなったこと・死活と担保が
キャッシュから返ることを稼働環境で確かめる。

Excubitor の再起動は全サービスの監視と Concordia → Revisor の経路に影響する共有インフラ操作なので、
実施は neco の開始指示を受けてから行う。再起動は本体フォルダで Excubitor 経由
(`npm run ctl -- excubitor restart --json`)、Concordia の testing claim → release を挟む。

## 完了条件

- 本体 `E:/Document/Ars/Excubitor` の `npm run build` と `npm --prefix frontend run build` が通っている。
- 再起動後の `GET /health` で started_at が更新され、版が 797d4fa 以降を名乗る。
- 棚卸しの 1 周 (`inventory pass complete`) で `git_status_runs` が checkout 数 (2026-09-21 実測 42) 前後に収まり、
  1 周のあいだに tasklist が起動していない (process snapshot 流用)。
- 死活確認が 60 秒周期で回り、`GET /api/v1/federation/coverage` の各サービスに `health.checked_at` が入る。
- `GET /api/v1/federation/mesh` が自拠点だけのメッシュ (ピア未登録) を返し、担保表の指摘 (`duplicate_managed` / `uncovered` / `down`) が実態と合う。
- `liveness_history` の増え方が「状態変化 + 5 分 heartbeat」になっている (1 時間あたり 93 × 12 行を超えない)。
- 停止通知が 60 秒周期で誤発火していない (再起動の数十秒で通知が飛ばない)。

## スコープ (編集可ディレクトリ)

- なし (反映と確認のみ。不具合が見つかったら別タスクを起こしてから直す)
