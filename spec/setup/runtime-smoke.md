---
title: Runtime smoke (backend boot check)
description: Excubitor backend を隔離環境で起動し /health を確認する外部プロセススモークの契約。
---

# Runtime smoke

`scripts/runtime-smoke.mjs` は Vitest では検証できない「backend が実際に起動して
listen するか」を確認する外部プロセススモーク。 Revisor の登録テストケース
`runtime-smoke` から実行される。

## 契約

- 起動は `node node_modules/tsx/dist/cli.mjs src/server.ts`、 cwd はスクリプト位置から
  解決したリポジトリ root (呼び出し元 cwd に依存しない)。
- 環境は本番常駐系と隔離する:
  - `EXCUBITOR_PORT=27332` — 既定 17332 ではないため共有 `.mcp.json` の reconcile は
    スキップされる (`mcp/mcp-json.ts` の gate)。
  - `EXCUBITOR_SAFE_MODE=1` — 起動セット autolaunch を抑止する (design.md / launcher.md)。
  - `EXCUBITOR_LOG_LEVEL=warn`。
- 最大 120 秒、 1 秒間隔で `http://127.0.0.1:27332/health` をポーリングし、 200 で成功。
  子が先に exit / spawn 失敗した時点で待機を打ち切る (signal 終了も exit として扱う)。
- 終了時は必ず子を回収する。 Windows は `taskkill /PID <pid> /T /F`、 POSIX は
  detached で起動したプロセスグループへ `SIGKILL` (tsx CLI が実サーバを孫として起動する
  ため、 直接の子だけを kill するとポートを掴んだまま孤児化する)。
- 成功ログには `/health` の body をそのまま出さない。 body は `instance_token`
  (supervisor が発行する adoption identity) を含むため、 `service` と `safe_mode` だけを出す。

## 非目標

- 起動セット・supervisor・OS service の検証は行わない (local-control 側の責務)。
- 本物の常駐 Excubitor (17332) には触れない。
