# 審査の非ブロック所見が毎回同じ 4 件出る

- Date: 2026-09-25
- Area: Anatomia / Augur / Revisor 連携のリポジトリ側設定
- Status: 2 件は本 PR で解消、2 件は別タスクへ切り出し

## Evidence

Excubitor #1946 の審査は `passed` だが advisory が 4 件付いた。

```
Augur 台帳未整備 (全体スイートを実行)
Anatomia 二層ドメイン（プログラム）: 316 件の変更アンカーが未分類
17 件の変更関数が孤立しています
複雑度比較は旧集計を使用: Function snapshots unavailable or invalid
```

いずれも #1946 固有ではなく、リポジトリ側の設定が無いために**どの PR でも**出る。
`anatomia pr-review --base 97e4509` で再現し、1 件ずつ実体を確かめた。

## Cause and fix

### 1. プログラムドメインが全件未分類 (解消)

`.anatomia/layers.json` が無かった。Anatomia は宣言の無いリポジトリには層を割り当てない
(`layerOfPath` は「何も主張しない」を返す) ので、変更アンカーが丸ごと `unclassified` になる。
Excubitor の実構造に沿って 36 本の glob を宣言し、`anatomia domains program` の
`unclassified` が 44 モジュール 3282 symbol → 0 になった。

依存方針 (`allow`) はまだ書かない。既存の層間依存を棚卸ししていない段階で書くと、
実態と違う方針を誰も決めていないのに敷くことになるため。まず分類を全域にし、
`crossDomainCoupling` の実測を見てから `order` / `allow` を足す。

### 2. 変更関数の孤立 (解消)

「孤立 (orphan)」は spec 結線ではなく**静的な呼び出し元が無い**関数を指す
(`anatomia review` の "Orphans (no static caller)")。18 件 (審査時 17 件 + その後の追加)
の内訳は次の 3 種だった。

- 解析の限界 / 誤検知 15 件
  - JSX でのみ生成される React コンポーネント 6 件
    (`MeshPanel` / `NodeDetailPanel` / `OperationTracker` / `Federation` / `SelfNodePanel` / `Viewer`)
  - `deps.x ?? impl` の既定実装として参照される 9 件
    (`downloadBundle` / `fetchLatest` / `executeOperation` / `frontendExists` / `controlStep` /
    `serviceIsRunning` / `serviceVersionStatus` / `newNonce` / `restartExcubitorViaLocalTool`)。
    既定引数・`??` の右辺にある参照を呼び出し辺として数えていない。
- 本当に未使用 2 件 — `targetLabel` (federation/operations/types.ts) と
  `resetSelfVersion` (federation/self-version.ts)。#1946 で足して一度も使わなかった。削除した。
- 本 PR の範囲外 1 件 — `fetchMemorySeries` (frontend/src/lib/api.ts)。
  2026-06-18 の #30 由来で、backend の `/api/v1/memory/series` はあるが画面から呼んでいない。
  #1946 が同じファイルを触ったため差分に乗っただけなので、ここでは消さない。

### 3. Augur 台帳未整備 (未解消・別タスク)

`.augur/tests.jsonl` が無いため、Revisor は影響ドメインのバンドルではなく全 140 本の
テストを毎回流している (`src/ci.mjs` の `ledgerPresent` 分岐)。

台帳を作るには各テストに**テスト対象コードのビジネスドメイン**を与える必要がある。
`spec/data/excubitor.taxonomy.json` は `src/**/*.test.ts` を一律 `test-environment` に
入れるので、テスト自身のパスでは引けない。対象実装ファイルで引き直すと 140 本中 58 本が
どのドメインにも一致しなかった (`src/local-control/**`、`src/process/**` など taxonomy が
まだ覆っていない領域)。

**半端な台帳は有害**: Revisor は `domain:<name>` のバンドルしか実行しないので、
ドメインの付かないテストは「登録済みなのに一生走らない」テストになる。
ビジネスドメイン層は二層モデルで人間承認 (Gate A) を要するため、taxonomy の拡張から
順に進める別タスクとする。

### 4. 複雑度比較が旧集計に落ちる (未解消・別タスク・Anatomia/Revisor 側)

Revisor の `complexity-comparison.mjs` は、スナップショット行数が同じ解析の関数数と
一致しない場合に比較を諦める。#1946 の実測値:

| | 集計の関数数 | スナップショット行数 | 差 |
|---|---|---|---|
| head | 3224 | 3275 | +51 |
| base | 3044 | 3096 | +52 |

さらに identity キー (`path` + `enclosingType` + `name` + `signatureShape`) は
head で 3275 行中 2143 種しかなく、1132 行が重複している。行数が一致したとしても
`match("key", true)` が「同名同型が複数」で `Ambiguous existing function identities` に
落ちる。無名関数・同名コールバックを多く持つリポジトリでは identity 突合が成立しない。

Excubitor 側では直せない (Anatomia の数え方か Revisor の `valid()` の期待のどちらかを
変える必要があり、全リポジトリの審査に影響する)。所見として別タスクへ出す。

## References

- 層宣言の契約: Anatomia `spec/feature/domain-dual-layer.md`、`src/domains/program/layer-paths.ts`
- 孤立の定義: Anatomia `src/review/format.ts` の "Orphans (no static caller)"
- 台帳の分岐: Revisor `src/ci.mjs` `runPlannedTests`
- 複雑度比較: Revisor `src/complexity-comparison.mjs` `valid` / `compareComplexity`

## Verification

`npx tsc --noEmit` 緑。`npx vitest run --pool=forks src/federation` は 18 ファイル 97 件
すべて緑 (削除した 2 関数を参照するテストは無い)。`anatomia domains program` の
unclassified が 0 になることを確認した。
