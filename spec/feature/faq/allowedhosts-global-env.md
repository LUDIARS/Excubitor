---
tags: [vite, allowedHosts, env, global-env, melpot]
date: 2026-06-30
---

# Q: Vite dev server で `*.melpot.dev` がブロックされる

## 症状

```
Blocked request. This host ('ex.melpot.dev') is not allowed.
To allow this host, add 'ex.melpot.dev' to server.allowedHosts in vite.config.js.
```

Cloudflare Tunnel 経由 (`*.melpot.dev`) でアクセスすると Vite が拒否する。

## 原因

Vite 5+ はデフォルトで `localhost` 以外のホストを拒否する。
Tunnel ドメインを個別に `allowedHosts` に書いても、他サービスに同じ変更が必要になり一括管理できない。

## 解決策

`LUDIARS_ALLOWED_HOSTS=.melpot.dev` を Excubitor の `catalog/services.yaml` で一元管理し、
子サービス起動時に自動注入する。

### 仕組み

1. `catalog/services.yaml` の `global.env` セクション (ファイル先頭) に定義:

   ```yaml
   global:
     env:
       LUDIARS_ALLOWED_HOSTS: ".melpot.dev"
   ```

2. Excubitor が `resolveInjectEnv()` で全サービスにこの env を注入 (`src/process/inject.ts`)。

3. 各サービスの Vite config が `LUDIARS_ALLOWED_HOSTS` を読んで `allowedHosts` に追加する:

   ```ts
   // Actio / Cernere / Nuntius / Schedula 系
   const extraHosts = [
     ...(process.env.VITE_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? []),
     ...(process.env.LUDIARS_ALLOWED_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
   ]

   // Pagus 系 (hardcoded array に spread)
   allowedHosts: [
     'pagus.vtn-game.com',
     'localhost',
     ...(process.env.LUDIARS_ALLOWED_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
   ]

   // Signum / Praeforma / Peregrinatio 系 (conditional spread)
   const ludiarsHosts = (process.env.LUDIARS_ALLOWED_HOSTS ?? '')
     .split(',').map(s => s.trim()).filter(Boolean);
   // server: { ...(ludiarsHosts.length > 0 ? { allowedHosts: ludiarsHosts } : {}) }
   ```

4. Vite の先頭ドット規約: `.melpot.dev` は `*.melpot.dev` 全サブドメインを許可する。

### 対象サービス (LUDIARS_ALLOWED_HOSTS 対応済)

Actio / Cernere / Nuntius / Schedula / Excubitor / Pagus / Signum / Praeforma / Peregrinatio
(2026-06-30 に一括対応、各リポ `feat/ludiars-allowed-hosts` → merged)

## 優先順位

`services.yaml global.env` < topology env < サービス固有 `env:` < Infisical secret

サービス固有に `LUDIARS_ALLOWED_HOSTS` を上書きしたい場合はサービスの `env:` セクションに書く。

## 新しいドメインを追加する場合

`catalog/services.yaml` の `global.env.LUDIARS_ALLOWED_HOSTS` をカンマ区切りで追記するだけ:

```yaml
global:
  env:
    LUDIARS_ALLOWED_HOSTS: ".melpot.dev,.example.com"
```

Excubitor の catalog ホットリロードが反映する (サービス再起動は必要)。
