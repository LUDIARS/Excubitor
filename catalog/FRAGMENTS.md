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

## 機密 (secret) の trust 境界

断片は任意リポ直下に置けるため、 そのままだと **どのリポでも** secret 系宣言
(`infisical` / `requires_secret` / `cernere_launch_credentials`) を書けてしまい、
「自分の断片から他サービスの secret を引き込む」 trust boundary の拡大になる。

そのため secret 系宣言の trust surface を **常に可視化** し、 **enforce モードで剥がせる** ようにする:

- secret 系宣言を持つ断片は、 モードに関わらず必ず warn ログを出す (trust surface を surface)。
- env `EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST` に **リポ dir 名** をカンマ区切りで設定すると
  **enforce モード** になり、 allowlist 外のリポの断片からは secret 系フィールドを剥がす
  (他フィールドは有効)。 未設定時は非破壊 (既存挙動維持) で warn のみ。

```
# 厳格化する: 列挙したリポの断片だけが secret を宣言できる
EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST=Cernere,Aedilis
```

- secret を確実に扱いたい定義は、 レビュー済みの `catalog/services.yaml` (正本) に置くのが本筋。

## 探索と反映

- 探索対象: `${ARS_ROOT}` 直下の各ディレクトリ + env `EXCUBITOR_FRAGMENT_DIRS`
  (カンマ区切りの追加ルート) 直下。 各 `<child>/excubitor.catalog.yaml` を 1 階層で拾う。
- 集積結果は各断片の **内容ハッシュ** をキーに **メモリキャッシュ** する (内容が変わらなければ
  再パースしない)。 mtime 非依存なので、 mtime を据え置いたまま内容だけ書き換わっても取りこぼさない。
- 一時エラー (走査 / 読み込み / parse の transient 失敗、 書き込み途中の YAML 等) は
  「サービス削除」 とは扱わない。 直近の成功結果を保持し、 既存サービスが黙って消えるのを防ぐ。
  実際にファイル/ディレクトリが無い (ENOENT) ときのみ削除として扱う。
- 既存断片の変更に加え、 **新規** 断片ファイルの出現も監視する (リポ dir + 走査ルートを
  ディレクトリ監視し、 `excubitor.catalog.yaml` の作成イベントで reload)。 fs.watch の
  確立に失敗した対象は握りつぶさず error ログで surface する。
- 有効な YAML だがスキーマ不一致の断片エントリは黙って捨てず warn を出す (`code` + zod issues)。
