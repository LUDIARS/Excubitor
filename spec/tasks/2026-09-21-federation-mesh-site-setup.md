---
task: federation-mesh-site-setup
project: Excubitor
kind: 雑用
created: 2026-09-21
memory_links:
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/project-infra-mac-migration.md
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/project-tailscale-shared-postgres.md
  - C:/Users/raury/.claude/projects/E--Document-Ars/memory/feedback-shared-infra-lifecycle-not-my-call.md
---
# 各拠点の Excubitor をメッシュでつなぎ、担保の重複を解消する

## 目的

拠点メッシュ (spec/feature/federation-mesh.md) は実装済みだが、どの拠点も拠点間リスナーを有効にしておらず、
ピアも 0 件 (2026-09-21 時点)。各拠点の Excubitor を Tailscale / Cloudflare Mesh 上で相互に登録し、
どの拠点がどのサービスを担保しているかと拠点間の死活を、どの拠点からでも見られるようにする。

各拠点のメッシュ側アドレスと agent token は拠点ごとの実機にしかなく、env 設定と Excubitor 再起動を伴うので、
neco が拠点と手順を決めてから進める。前提: `2026-09-21-federation-mesh-deploy` が済んでいること。

## 完了条件

- 参加する拠点の一覧 (拠点名 = `EXCUBITOR_NODE_NAME` と、Tailscale / Cloudflare Mesh のアドレス) が決まっている。
- 各拠点の env に `EXCUBITOR_FEDERATION_LISTEN=<その拠点のメッシュ側アドレス>` があり、
  Federation タブ「このノード」に拠点間リスナーの URL (`http://<address>:17335`) が出ている。
- Tailscale ACL / Cloudflare Mesh のポリシーで、拠点間は 17335/tcp が通り、LAN 側からは届かない。
- 全拠点の組み合わせでピア登録され、各拠点の「疎通」が `接続` になる。
- `GET /api/v1/federation/mesh` のつながり表で、全拠点ペアが両方向とも `up`。
- 担保表の `duplicate_managed` が 0 件 (担保しない側の拠点で「担保しない」に上書き済み)、
  `uncovered` が残っていれば担保する拠点を決めてある。

## スコープ (編集可ディレクトリ)

- なし (各拠点の env・ピア登録・担保上書きは各拠点の Excubitor の DB / 設定 UI で行う。リポのファイルは変えない)
