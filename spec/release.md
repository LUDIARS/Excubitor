# Excubitor release サブシステム — 自己完結ランナブル配布物 (v0.1)

LUDIARS サービスを「展開して起動するだけ」のフォルダ + zip に焼く仕組み。
最初の対象は **Discutere オールインワン** (Di + Lictor + Famulus + Canalis)。

> なぜ Excubitor か: Excubitor は既に catalog (どこに何の repo があるか) / update
> (git HEAD↔origin) / launch (起動オーケストレーション) / process (detached spawn) を
> 持つ運用コア。 「複数 repo を集めて 1 つの成果物にする」リリース工程はこの延長線にある。

---

## 1. コンセプト

1 つの **リリースマニフェスト** (`releases/<name>.yaml`) が 1 配布物を宣言する。

- **primary** : 起動エントリのアプリ (Discutere)。 バンドルの `app/` に入る (1 つだけ)。
- **components** : 同梱する関連 repo。 役割は `lib`(import される) / `cli`(実行ファイルを持つ) / `optional`。
- 各 component は repo パス・build 手順・バンドルへ取り込む include パスを持つ。

ビルドは **build → assemble → launcher → archive** の 4 段:

```
① build    : 各 repo で build 手順を実行 (npm ci / npm run build)
② assemble : include をバンドルへコピー + staged 側で `npm ci --omit=dev` (prod node_modules)
③ launcher : start.bat / start.sh + bin shim + README.txt + VERSION.json を生成
④ archive  : バンドル dir を zip 化 (Win=Compress-Archive / 他=zip)
```

## 2. バンドルのレイアウト

```
discutere-allinone-<version>/
├── start.bat / start.sh        # PATH に bin/ を載せて app/ で起動コマンドを叩く
├── bin/<name>.cmd / <name>     # role=cli を PATH に出す shim (node 経由で entry を起動)
├── app/                        # primary (dist + prod node_modules + package.json + config 雛形)
├── packages/<code>/            # lib / cli (dist + prod node_modules + bin)
├── runtime/node(.exe)          # runtime.bundle=true のときだけ同梱
├── VERSION.json                # name / version / built_at / 各 component の branch+commit+dirty
└── README.txt                  # 起動方法・前提・セットアップ手順
```

新サービスを配布したくなったら **`releases/<name>.yaml` を 1 枚足すだけ** (コード追加不要)。

## 3. マニフェスト (`releases/discutere-allinone.yaml` 参照)

| キー | 意味 |
|---|---|
| `name` / `display_name` / `description` | バンドル名と表示用メタ |
| `primary` | role=primary の component code |
| `components[].role` | `primary` / `lib` / `cli` / `optional` |
| `components[].path` | repo の絶対パス。 省略時は catalog の同 code から解決 |
| `components[].build` | repo で順に実行するコマンド列 |
| `components[].include` | バンドルへコピーするパス (既定 `[dist, package.json, package-lock.json]`) |
| `components[].prod_install` | staged 側で `npm ci --omit=dev` を走らせるか (既定 true) |
| `components[].bin_name` / `bin_entry` | role=cli の PATH コマンド名と実行スクリプト |
| `start_command` | launcher が app/ で叩くコマンド (既定 `node dist/index.js`) |
| `runtime.bundle` / `runtime.node_path` | Node 本体を同梱するか (既定 false = host の Node 22+) |
| `readme_notes` | README.txt に出すセットアップ手順 |

## 4. 起動方法 (操作面)

- **CLI** (headless でバンドルを焼く):
  ```sh
  npm run release -- discutere-allinone            # build + assemble + zip
  npm run release -- discutere-allinone --dry-run  # repo 解決 + git meta のみ
  npm run release -- discutere-allinone --skip-build --skip-archive
  ```
- **HTTP** (Excubitor サーバ経由 / GUI 連携用):
  - `GET  /api/v1/releases` — マニフェスト一覧
  - `GET  /api/v1/releases/:name` — マニフェスト + dry-run plan (repo 解決 + git meta)
  - `POST /api/v1/releases/:name/build` — 実ビルド (body: `version` / `skipBuild` / `skipInstall` / `skipArchive`)

出力は `dist/releases/<name>-<version>/` と同名 `.zip` (`dist/` は gitignore 済)。

## 5. モジュール構成 (`src/release/`)

| ファイル | 役割 |
|---|---|
| `manifest.ts` | zod スキーマ + 型 + YAML ローダ + `releases/` 列挙 |
| `plan.ts` | repo パス解決 + バンドル配置先 + build 順 (lib/cli→primary) |
| `git-meta.ts` | repo の branch / 短縮 commit / dirty (VERSION.json 用) |
| `steps.ts` | build 手順 runner (注入可。 既定は shell 経由) |
| `assemble.ts` | include コピー + prod install |
| `launcher.ts` | start.bat/sh・shim・README・VERSION.json の純レンダラ |
| `archive.ts` | zip 化 (OS 別、 追加依存なし) |
| `orchestrator.ts` | 4 段を束ねる `buildRelease()` |
| `router.ts` | HTTP API |
| `cli.ts` | headless CLI (`npm run release`) |

## 6. 設計判断

- **build runner は注入** (`StepRunner`)。 テストは fake で npm を実際に叩かずに
  assemble/launcher/VERSION までの組み立てを固定する (`orchestrator.test.ts`)。
- **prod node_modules は staged copy で `npm ci --omit=dev`**。 native dep (better-sqlite3 /
  node-pty) はビルドマシンの prebuild を取り込む → 配布先はビルドマシンと同 OS が前提。
- **Lictor / Famulus は role=cli**。 Di は今これらを npm 依存にしておらず、 `lictor` /
  `famulus` を **コマンドとして spawn** する経路 (Claude CLI 経由 / ローカル LLM) なので、
  vendoring + PATH shim が実態に合う (Di の node_modules に混ぜない)。
- **Canalis は role=lib** (Di の ②transform が import する取込基盤)。

## 7. v0.1 の非目標 / follow-up

- **Node ランタイムの既定同梱はしない** (host の Node 22+ を要求)。 SEA / pkg での完全同梱は
  `runtime.bundle` + `node_path` で部分対応済 (node バイナリをコピーするだけ。 cross-OS 焼きは未対応)。
- **GitHub Release への自動 upload / 署名 / cross-platform ビルド** は未対応。
- **配布先での起動スモークテスト** は未自動化 (生成物の手動確認止まり)。
- frontend (Monitor/Catalog/Errors) の **Releases ページ** は未実装 (API のみ提供)。
