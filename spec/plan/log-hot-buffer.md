# ログホット参照層 — Valkey リングバッファ + 当日集計 (v1.0)

- ステータス: **設計起草 (2026-07-12) / レビュー待ち**
- オーナー: Excubitor (ホット参照層)。 イベント規約のオーナーは Vestigium
  (`LUDIARS/Vestigium` DESIGN.md §2.4、 同時 PR)
- 関連: [`log-store.md`](log-store.md) (v1.0 — 正本 JSONL + 遅延 DuckDB)、
  Vestigium DESIGN §2.2/§2.4

---

## 1. 背景 / 課題

log-store v1.0 で「正本 = JSONL/Parquet、 履歴クエリ = 遅延 DuckDB、 ライブ =
リングバッファ」の分担は確立した。 残る課題は**常時ウォッチされる参照系**:

- **コスト (LLM 使用量) / セッション / エラー**は UI・MCP から高頻度で参照される。
  アクセスパターンは「最新から遡って N 件」+「当日累計」
- 遅延 DuckDB 経路はホット日で ~0.3-0.5s。 on-demand の履歴調査には十分だが、
  常時ポーリングの裏側には向かない
- 既存のインメモリリングは global 20k 行のみで、 高頻度 info (Concordia
  transcript-frame 等) が error 行や llm 行を押し出す — カテゴリ別の保持保証がない
- カテゴリ別リングをインメモリで増やすと Excubitor backend の RSS に戻ってくる
  (crash-2026-07 の教訓: 監視プロセス自身にバッファを抱えさせない)

## 2. 決定

**ホット参照層を Valkey (Redis 互換, infra tier) に置く。 正本は引き続き
JSONL/Parquet であり、 Valkey は全損しても正本から復元可能な参照キャッシュとする。**

1. カテゴリ別リングは **Redis Streams の `XADD ... MAXLEN ~ N`** で表現する
   (上限付き追記 + 古い方から消える = リングバッファの定義そのもの)。
   「最新から N 件」は `XREVRANGE ... COUNT N`
2. セッションは **hash + sorted set** (エンティティなので stream より上書きが合う)
3. 当日コスト累計は **`HINCRBYFLOAT`** の日付キー + TTL (再起動しても再スキャン不要)
4. 書き込みは **Excubitor の bus 購読者 1 箇所のみ**。 サービス → Vg JSONL →
   file-tail → bus → Valkey の一方向を守り、 Vg writer のローカル I/O 原則を壊さない
5. Valkey 未接続時は**小上限のインメモリリングへ自動縮退** (driver 切替)。
   error-detector / SSE は bus 直結のまま Valkey 非依存

## 3. アーキテクチャ

```
[各サービス] ─Vg SDK─▶ <logs>/<code>/YYYY-MM-DD.jsonl   (正本, 無変更)
                          │
              file-tail ─▶ log bus
                          ├─▶ error-detector (既存, Valkey 非依存)
                          ├─▶ SSE /logs (既存, bus 直結)
                          └─▶ hot-buffer writer (新) ──▶ Valkey
                                                          ├ vg:ring:llm / vg:ring:error / vg:ring:all
                                                          ├ vg:session:<id> + vg:sessions:recent
                                                          └ vg:cost:<YYYY-MM-DD>
[常時参照] /api/v1/logs/recent?category=… · /api/v1/llm/costs · /api/v1/llm/sessions
   └▶ Valkey 読み (XREVRANGE / ZREVRANGE / HGETALL) — 常に高速
[履歴深掘り] /api/v1/logs/query (既存 遅延 DuckDB) — 無変更
```

### キー設計

| キー | 型 | 内容 | 上限 |
|---|---|---|---|
| `vg:ring:llm` | stream | `channel==='llm'` の行 | `MAXLEN ~ 5000` |
| `vg:ring:error` | stream | `level>='error'` の行 | `MAXLEN ~ 2000` |
| `vg:ring:all` | stream | 全行 (既存 global リングの置換) | `MAXLEN ~ 20000` |
| `vg:session:<id>` | hash | service / started_at / last_at / turns / cost_usd / status | TTL 7d |
| `vg:sessions:recent` | zset | member=session_id, score=last_at | `ZREMRANGEBYRANK` で 500 件 |
| `vg:cost:<YYYY-MM-DD>` | hash | field=`<service>:<model>`, value=累計 (calls/tokens は `vg:cost:<date>:calls` 等の並列 hash) | TTL 48h |

- stream entry のフィールドは bus の LogLine と同形 (code / channel / ts / level / line)
- `MAXLEN ~` (近似トリム) でトリムコストを償却
- Valkey 側は `maxmemory` + `noeviction` を設定し構造上限と二重に防ぐ

### イベント規約 (Vestigium 側)

セッション・コストの抽出は Vg DESIGN §2.4 (同時 PR) の `channel:"llm"` 規約に従う:
`ctx.evt` = `llm_call` | `session_start` | `session_end`、 `session_id` / `model` /
`in_tokens` / `out_tokens` / `cost_usd`。 `evt` の無い llm 行はリングにのみ入る
(集計対象外)。 ctx は元々任意 JSON のため JSONL スキーマとしては非破壊。

## 4. 縮退設計 (bootstrap 依存の回避)

Excubitor は自分がインフラを起動する側のため、 「Valkey が上がるまでログ参照が
死ぬ」依存を作らない:

- hot-buffer は driver インターフェース `memory | valkey` を持つ
- Valkey 未接続 (起動前 / 落ちた): インメモリ driver に自動縮退
  (ring 上限は 1/4 程度に絞る)。 復帰検知で valkey driver へ切り戻し
  (縮退中のメモリリング内容は流し込まず破棄 — 直近分は bus から自然回復し、
  欠けは正本 `/logs/query` で引ける)
- 書き込み失敗は warn ログのみ (Vg writer と同じ failure-safe 方針)。
  参照 API は接続状態を `source: "valkey" | "memory"` として返し UI で可視化

## 5. 永続化 / 復旧

- Excubitor 再起動: Valkey が生きていればリング・セッション・当日累計は無傷
  (log-store v1.0 の「末尾逆読み prefill」相当は不要になる)
- Valkey 再起動: RDB スナップショット (数分間隔) で十分。 欠けるのは直近数分の
  リング内容のみで、 正本から `/logs/query` で引ける。 AOF は使わない
- Valkey 全損: キャッシュなので作り直し。 当日コスト累計のみ、 起動時に当日
  JSONL の `channel==='llm'` 行を 1 回スキャンして再計算する backfill を持つ
  (リング / セッションは bus から自然回復)

## 6. デプロイ

- `infra/` に **Valkey** コンテナを追加し catalog に `tier: infra` で登録
  (Excubitor 自身が docker スキャンで死活監視できる)
- 接続先は catalog `env:` 注入: `EXCUBITOR_VALKEY_URL` (既定
  `redis://127.0.0.1:6379`)。 未設定なら memory driver で動作 (開発時の既定)
- loopback bind + パスワード無しを既定とし、 拠点間で共有しない
  (federation 越しの参照は既存の API プロキシ経路のまま)

## 7. インターフェース変更

### HTTP API

- `GET /api/v1/logs/recent` — `category=llm|error|all` を追加。 読み先を
  Valkey (縮退時 memory) に付替え。 既存パラメータ互換
- `GET /api/v1/llm/costs` (新) — 当日 (+ TTL 内の前日) の累計。
  params: `date?`, `group=service|model`。 それより過去は `/logs/query` 側の集計へ
- `GET /api/v1/llm/sessions` (新) — `vg:sessions:recent` から最近 N 件
- `GET /api/v1/services/:code/logs` (SSE) — 無変更 (bus 直結)

### MCP

- `excubitor_recent_logs` — `category` param 追加 (裏が Valkey になる)
- `excubitor_llm_costs` / `excubitor_llm_sessions` (新) — 上記 API の薄いプロキシ

### catalog

```yaml
log_store:
  ring_lines_per_service: 2000     # 既存
  ring_lines_global: 20000         # 既存 → vg:ring:all の MAXLEN に転用
  compact_hour_utc: 18             # 既存
  hot_buffer:                      # 新
    driver: valkey                 # valkey | memory
    ring_llm: 5000
    ring_error: 2000
    sessions_max: 500
    cost_ttl_hours: 48
```

## 8. 実装フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| 1 | Vg DESIGN §2.4 規約 + SDK emitter (`createLlmEmitter`) | Vg から規約準拠の llm 行が吐ける |
| 2 | infra Valkey + hot-buffer driver (memory/valkey) + カテゴリ別リング + `/logs/recent?category` | Valkey 停止でも縮退動作。 recent が押し出しなしでカテゴリ別に返る |
| 3 | セッション / 当日コスト集計 + `/llm/costs`・`/llm/sessions` + MCP tools | UI/MCP からコスト・セッションが ms 応答 |
| 4 | UI (Monitor タブへのコスト・セッションパネル) | 常時ウォッチが DuckDB を起こさない |

Phase 1 は Vestigium 側 PR。 Phase 2+3 を Excubitor 1 PR、 Phase 4 は frontend PR を想定。

## 9. リスクと対策

- **Valkey という常駐依存の追加**: 監視系の生命線 (error-detector / SSE / 死活) は
  bus 直結で Valkey 非依存に保つ。 死ぬのは「ホット参照の高速性」だけで、 それも
  memory 縮退で機能は残る
- **二重管理 (正本 vs キャッシュ) の整合**: 突き合わせはしない。 キャッシュは
  lossy 前提と明示し、 監査的な参照は必ず `/logs/query` (正本) を使う
- **stream entry の肥大**: line は Vg 仕様で 64KB 上限 + MAXLEN で構造上限。
  `maxmemory-policy noeviction` で溢れは書き込みエラー → warn 縮退
- **Windows ホスト**: Valkey は Docker 経由 (infra tier の既存運用と同じ)。
  Docker 無しの開発機は memory driver 既定で影響なし
- **機微情報**: llm 規約はメタデータのみ (prompt/response 本文禁止, Vg CLAUDE.md)。
  Valkey は loopback bind のためファイル正本と同じ信頼境界に留まる

## 10. 効果見込み

- コスト / セッション / エラーの常時参照が Excubitor RSS を消費しない
  (カテゴリ別リング数 MB ぶんが Valkey 側へ)
- Excubitor 再起動でホット参照が消えない (prefill 実装も不要)
- 「直近 N 件」が DuckDB 起動 (~0.3-0.5s) を踏まず常に高速
- 当日 LLM コストのリアルタイム累計という新機能が乗る (これまで不可視)
