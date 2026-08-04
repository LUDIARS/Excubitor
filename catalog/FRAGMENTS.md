# サービス所有 catalog (per-repository catalogs)

サービス定義の正本は、各サービスの所有リポジトリにある
`${ARS_ROOT}/<repo>/excubitor.catalog.yaml` だけ。Excubitor は全 source を集積するが、
中央 service catalog、DB snapshot、scan 結果への fallback は行わない。

## なぜ断片なのか

中央 catalog は ownership を曖昧にし、サービス変更との同期漏れ・private 情報の流出・
古い定義による誤起動を起こす。各サービス自身のリポに置けば、定義と実装を同じ変更単位で
管理でき、private 定義も private リポ内に留まる。

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

- `services:` 配下は `src/catalog/loader.ts` の `ServiceSchema` に従う。
- top-level は `services:` のみ。 `project_versions` 等の全体設定は持たない。
- 1 リポが複数の論理サービス (backend / worker 等) を持つなら、 配列に複数エントリを並べる。
- `${ARS_ROOT}` / `${DOMAIN_ROOT}` プレースホルダが使える (マシン依存の実パス/ドメインを焼かない)。

## 探索と反映

- 探索対象: `${ARS_ROOT}` 直下の各ディレクトリ + env `EXCUBITOR_FRAGMENT_DIRS`
  (カンマ区切りの追加ルート) 直下。 各 `<child>/excubitor.catalog.yaml` を 1 階層で拾う。
- 内容 hash が変わらない source はメモリ cache を再利用する。
- 一時的な read/YAML/shape failure は source ごとの last-known-good を保持し、warning として観測可能にする。
- 既存ファイルは個別 file watch、新規・削除・watch error は 5 秒 polling で検出する。
- git worktree は未マージ定義の混入を防ぐため探索対象外。
- runnable command を含むため、LUDIARS origin または明示 allowlist により信頼されたリポだけを受理する。
- 複数 source が同じ `code` を宣言した場合、黙って先勝ちにせず、その code を fail-closed で除外する。
- catalog がないサービスは集積対象外。中央定義で救済せず、起動・再起動時に明示的に失敗させる。

Excubitor 自身の `memory_monitor` / `retention` / `log_store` / 共通非 secret env は
root の `excubitor.config.yaml` に置く。このファイルへ `services:` を書くと起動時に拒否される。
