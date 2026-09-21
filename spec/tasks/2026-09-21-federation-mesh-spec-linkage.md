---
task: federation-mesh-spec-linkage
project: Excubitor
kind: 実装
created: 2026-09-21
memory_links:
  - C:/Users/raury/.claude/projects/E--Document-Ars-Excubitor/memory/anatomia-spec-linkage-mechanics.md
---
# 拠点メッシュ / 監視ループ変更の spec 結線と結合度の所見を解消する

## 目的

#1943 の Revisor 審査で、Anatomia の非ブロック所見が 2 つ出た。

- spec_linkage: 変更関数 17 アンカーが spec に結線されていない。原因は
  `spec/feature/federation-mesh.md` の `SPEC-FEDERATION-COVERAGE` / `SPEC-FEDERATION-HEALTH-CACHE` が
  見出しの `{#SPEC-...}` ではなく本文の太字にしか無いこと (Anatomia は見出しの id しか拾わない)、
  および `@implements` を付けていないファイルがあること。
  対象: `frontend/src/components/federation/{MeshPanel,CoveragePanel}.tsx`、
  `src/federation/{peer-cache,peer-response}.ts`、`src/scanner/downtime-alert.ts` (`recordFailedProbes`)、
  `src/scanner/version-reconcile.ts` (`syncDiskVersions`)。
- coupling_delta: アンカー `feec7e880fa6e287` の結合度が 16 (リポの p95 = 10) を超えた。

## 完了条件

- `spec/feature/federation-mesh.md` の 3 つの要求 (MESH / COVERAGE / HEALTH-CACHE) が、それぞれ `{#SPEC-...}` 付きの見出しを持つ。
- 上記の対象ファイルが該当する SPEC を `@implements` で参照している (監視ループ側は `SPEC-MONITOR-LIGHTWEIGHT`)。
- Anatomia の spec_linkage で上記 17 アンカーが孤立として出ない。
- coupling_delta のアンカーを特定し、結合度を p95 以下に下げるか、下げない理由 (単一責任である根拠) を spec か PR 説明に残す。
- 振る舞いは変えない (既存テストがそのまま通る)。

## スコープ (編集可ディレクトリ)

- `spec/feature/`
- `spec/plan/`
- `src/federation/`
- `src/scanner/`
- `frontend/src/components/federation/`
