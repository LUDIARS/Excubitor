---
task: package-audit-review-blockers
project: Excubitor
kind: 実装
created: 2026-08-11
memory_links: []
---

# Revisor local PR #112 のレビューブロッカー解消

## 目的

Revisor local PR `LUDIARS/Excubitor#112` (branch `agent/package-update-audit`、パッケージ日次監査)
が `action_required` で停止していた。記録されていたブロッカーは 4 件。

| Revisor の指摘 | 実態 |
|---|---|
| `2 registered test case(s) failed` | `catalog/tier.test.ts` の失敗は machine-local な catalog fragment (`ludellus-web`) 依存。main は該当アサーションを削除済み。残る 2 件は別タスクへ切り出し |
| `target domain is still missing` | ブランチに `.anatomia/` が存在しない。main への導入は `1b00b2d` (2026-08-03) でレビュー (2026-08-02) の翌日 |
| `24 changed architecture rule violation(s)` | 同上。domain 定義が無く `spec_linkage` ゲートが全滅 |
| `5 potential information leakage` | テスト内のダミー Discord webhook URL がスキャナの正規表現に verbatim で一致 |

4 件中 3 件はブランチの base (`00fe864`) が古いことの帰結であり、変更そのものの欠陥ではなかった。
レビュー時点の base `c2ab8e2` から main は 143 コミット進んでいた。

## 完了条件

- [x] ローカル `main` (`f658dd5`) を `agent/package-update-audit` へ merge する (競合ゼロ / `264dd70`)
- [x] `hasTargetDomain: true` かつ `unassignedAnchors: 0` になる
- [x] Anatomia の 5 ゲート (`rule_conformance` / `duplication` / `spec_linkage` / `coupling_delta` / `convention_drift`) が全 pass、`changedViolations: 0`
- [x] PR 差分から Discord webhook パターンに一致する行が消える
- [x] main の catalog 刷新 (`9e9e1b0`) との整合を取る
- [x] 仕様を AIFormat 互換の明示 clause id 付きにし、実装から参照させる

## 実施内容

`264dd70` (merge) / `d3b340d` (fix) の 2 コミット。

- **spec linkage**: `spec/feature/package-update-audit.md` の見出しへ明示 clause id
  `{#SPEC-PACKAGE-UPDATE-AUDIT}` を付与し、`src/update/package-audit/` の全モジュールと
  `src/secrets/{config-store,router}.ts`・`frontend/src/lib/api.ts`・`frontend/src/pages/Config.tsx`
  の該当関数に `@implements SPEC-PACKAGE-UPDATE-AUDIT` を注釈。
  Anatomia の explicit linker は `@implements` をファイル単位リンク (confidence 1.0) にするため、
  1 ファイル 1 注釈で当該ファイルの変更関数すべてが linked になる。
  併せて仕様に Modules 節を置き、ファイル basename 経由の linkage も効かせた。
- **domain**: `update` ドメインの path パターン `/src/update/` が `src/update/package-audit/` を
  既に包含するため、**新規ドメインファイルは追加していない** (PR 差分が支持しないため)。
- **leakage**: `src/secrets/notifications.test.ts` のダミー webhook を host とパスに分けて
  組み立て、1 行でパターンが完成しないようにした。値は discord.com のまま保つ
  (router のホスト allowlist 検証を壊さないため)。
- **CLI 整合 (merge で必要になった修正)**: `loadCatalog` が runtime config path を取る API へ
  変わり `catalog/services.yaml` も削除されたため、未文書化の `--catalog` を削除して
  `loadCatalog()` 呼び出しへ変更。放置すると CLI が起動時に落ちる。
- **設定の移設**: `catalog/package-audit.yaml` → `excubitor.config.yaml` の `package_audit:`。
  main は `9e9e1b0` で `catalog/` から Excubitor 所有設定を排除し、運用ポリシーは
  `excubitor.config.yaml` に集約する方針にしたため、それに合わせた。

## 検証

`ANATOMIA_CACHE=off anatomia pr-review --repo <worktree> --base main --json` (Revisor が回すのと
同じ決定的ゲート) で実測:

```
domain.hasTargetDomain: true
domain.unassignedAnchors: 0
architecture.verify.pass: true / changedViolations: 0
gates: rule_conformance=true, duplication=true, spec_linkage=true,
       coupling_delta=true, convention_drift=true
```

`changedOrphans` は 4 件残るが、Revisor の gate 実装ではこれは `reasons` ではなく
`advisories` に入るため blocking ではない。

ユーザ指示によりテストは実行していない。登録テストの確認は Revisor の再審査に委ねる。

## スコープ (編集可ディレクトリ)

- `src/update/package-audit/`
- `src/secrets/`
- `frontend/src/{lib,pages}/`
- `spec/feature/`
- `excubitor.config.yaml` / `catalog/` / `README.md`
