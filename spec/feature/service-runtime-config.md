# feature: encrypted service runtime configuration

Excubitor が service 固有の完全な runtime config を `config.enc` に暗号化保存し、対象
child process の spawn 時だけ environment として渡す機能。最初の consumer は Genius。

正本ソース:

- 保存・status: `src/secrets/config-store.ts`
- 管理 API: `src/secrets/router.ts`
- spawn 注入: `src/process/inject.ts`
- Web API client: `frontend/src/lib/api.ts`
- Genius 編集テンプレート: `frontend/src/lib/genius-runtime-config.ts`
- Web UI カード: `frontend/src/components/GeniusRuntimeConfigCard.tsx`
- Web UI 組み込み先: `frontend/src/pages/Config.tsx`

## 目的

repository 内の ignored config file を人手で用意し忘れると、サービスが起動しないか、古い
設定を読み続ける。設定を Excubitor の Web UI で一元管理し、暗号化保存した値を起動時だけ
注入することで、設定源と child process への受け渡しを一つにする。

## 保存と公開境界

1. Web UI は完全な JSON object を `PUT /api/v1/config/services/:code/runtime-config` に送る。
2. Excubitor は `serviceRuntimeConfigs[code]` として `config.enc` に AES-256-GCM 暗号化保存する。
3. GET / PUT response は `configured` とトップレベルの `keys` だけを返す。値本文・保存先を含む
   個人パス・接続先は返さず、ログにも出さない。保存失敗時も OS error の本文は公開しない。
4. `resolveInjectEnv()` は対象 code の値だけを
   `EXCUBITOR_SERVICE_CONFIG_JSON` に serialize して child process へ注入する。

設定は **次回 spawn から** 反映される。保存 API 自体は既存サービスを restart しないため、
運用時の restart は Excubitor lifecycle 手順に従って明示的に行う。

## Genius contract {#SPEC-SERVICE-RUNTIME-CONFIG-GENIUS-TEMPLATE}

- **本 feature が提供するのは Excubitor 側 (保存・管理 API・spawn 時注入) だけ**。 Genius が
  `EXCUBITOR_SERVICE_CONFIG_JSON` をローカル `genius.config.json` より優先して読む変更は
  Genius repository 側の follow-up であり、 2026-09-21 時点で未実装 (Genius の
  `src/config/load-config.ts` は config file + `GENIUS_*` の個別 override だけを見る)。
  それまで注入された変数は Genius から参照されない。 既存の `genius.config.json` を
  消してはならない。
- Genius 側を対応させたあとの契約: `EXCUBITOR_SERVICE_CONFIG_JSON` があればそれを
  ローカル `genius.config.json` より優先する。
- Web UI の「全項目を入力」は、現在の `genius.config.example.json` と同じ
  `dataDir` / `embedding` / `distill` / `notify` / `questions` / `contradiction` /
  `queryLog` / 全 `sources` を展開する。各値は保存前に編集できる。
- payload は Genius schema を満たす完全な base config でなければならない。JSON 不正・schema
  不正は fail-closed で起動エラーになる。
- port は payload に含めない。Excubitor catalog / ProcessMap が唯一の正本で、Genius には
  `GENIUS_PORT` が注入される。
- Infisical secret / `requires_secret` が同名 environment variable を提供する場合はそれらが
  runtime config より優先する。runtime config 自身は単一 JSON environment variable なので、
  config の個別 field を直接上書きしない。

## API {#SPEC-SERVICE-RUNTIME-CONFIG-API}

```text
GET /api/v1/config/services/:code/runtime-config
→ { code, runtime_config: { configured, keys } }

PUT /api/v1/config/services/:code/runtime-config
{ "config": { "dataDir": "./data", "embedding": { ... } } }
→ { ok: true, code, runtime_config: { configured, keys } }

PUT /api/v1/config/services/:code/runtime-config
{ "config": null }
→ 設定を削除
```

`config` は object または `null` だけを受け付ける。本文の再取得 API は提供しない。
service code / config の検証エラーは 400、保存 I/O の失敗は local path を含まない generic な
`runtime_config_save_failed` (500) を返す。
