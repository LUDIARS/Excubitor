# サービス catalog 断片 (per-repo fragments)

Excubitor の catalog は 3 ソースをマージして構成する。 優先順位は上ほど強い:

1. **`catalog/services.yaml`** — この (公開) Excubitor リポの手書き正本。
2. **各サービスリポの断片** — `${ARS_ROOT}/<repo>/excubitor.catalog.yaml`。
3. **`catalog/services.auto.yaml`** — スキャナが自動検出した分 (auto-catalog)。

同じ `code` は上位ソースが勝ち、 下位は捨てる。

## なぜ断片なのか

公開 Excubitor リポの `services.yaml` に **private リポの定義** (repo 名 / ポート /
トポロジ / infisical project_id) を焼き込むと、 それ自体が private 情報の流出になる。
各サービスの catalog エントリを **そのサービス自身のリポ** に置けば、 private な定義は
private リポの中に留まり、 Excubitor は走査して集めるだけになる。

## 断片ファイルの置き方

各サービスリポの **リポ直下** に `excubitor.catalog.yaml` を置く:

```yaml
# <repo>/excubitor.catalog.yaml
services:
  - code: foo
    name: Foo
    tier: saas
    project_code: foo
    port: 1234
    repo: LUDIARS/Foo          # 自分の repo を書いてよい (自リポなので流出にならない)
    runtime: node
    cwd: ${ARS_ROOT}/Foo       # ${ARS_ROOT} / ${DOMAIN_ROOT} は Excubitor が補間する
    command: npm run dev
    health:
      type: http
      url: http://localhost:1234/health
```

- `services:` 配下は `catalog/services.yaml` の各サービスと **同一スキーマ**
  (`src/catalog/loader.ts` の `ServiceSchema`)。
- top-level は `services:` のみ。 `project_versions` 等の全体設定は持たない。
- 1 リポが複数の論理サービス (backend / worker 等) を持つなら、 配列に複数エントリを並べる。
- `${ARS_ROOT}` / `${DOMAIN_ROOT}` プレースホルダが使える (マシン依存の実パス/ドメインを焼かない)。

## 探索と反映

- 探索対象: `${ARS_ROOT}` 直下の各ディレクトリ + env `EXCUBITOR_FRAGMENT_DIRS`
  (カンマ区切りの追加ルート) 直下。 各 `<child>/excubitor.catalog.yaml` を 1 階層で拾う。
- 集積結果はファイル集合 + mtime をキーに **メモリキャッシュ** する (変化が無ければ再パースしない)。
- 既存断片の変更は file watch で自動 reload。 **新規** 断片ファイルの出現は、
  何らかの reload (services.yaml 変更 / scan / Excubitor 再起動) を 1 度跨ぐと監視対象に入る。
