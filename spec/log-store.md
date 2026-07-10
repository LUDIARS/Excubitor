# ログストア再設計 — Vestigium 正本 + 遅延 DuckDB (v1.0)

- ステータス: **設計合意済 (2026-07-10 neco 承認) / 実装待ち**
- オーナー: Excubitor (格納・クエリ面)。 ファイル仕様のオーナーは Vestigium (`LUDIARS/Vestigium` DESIGN.md §2)
- 関連: [`spec/design.md`](design.md) §log、 PR #65 (retention 導入)、 Vestigium DESIGN §2 (JSONL 仕様)

---

## 1. 背景 / 課題

2026-07-10 のメモリ調査で、 ログ格納が Excubitor 肥大の主因と判明した:

- `service_instance_logs` (SQLite) が **84 万行 / 索引込み ~220MB**、 削除経路なし
  (PR #65 で 72h retention を導入し止血済み)
- ログの流れが **二重保存** になっている:
  サービス → Vestigium JSONL (正本) → Excubitor file-tail → **同じ行を SQLite へ再永続化**
- 高頻度 info ログ (Concordia transcript-frame 等) が stdout 86MB/3日 → tail → DB と
  増幅され、 SQLite の WAL/ページキャッシュが backend RSS を押し上げていた
- 今後ログ量は増える見込み (neco)。 行単位 DELETE + VACUUM の retention は
  量に対してスケールしない (実測: 60 万行 DB の VACUUM 15s ブロッキング)

## 2. 決定

**Vestigium JSONL (`<logs>/<code>/YYYY-MM-DD.jsonl`) を唯一の正本とし、
Excubitor はログを DB に持たない。**

1. ライブ面 (SSE / recent / error-detector) は log bus + **インメモリリングバッファ**で処理
2. 履歴クエリは**クエリ時だけ DuckDB インスタンスを開いて JSONL / Parquet を直読み**
   (常駐 RSS ゼロ。 in-memory instance open 実測 38ms)
3. **日次バッチで前日分 JSONL → Parquet (ZSTD)** に圧縮 (実測 1/20)。
   日付ファイル分割がそのままパーティションプルーニングになる
4. retention は**ファイル削除のみ** (JSONL は Vestigium sweeper、 Parquet は Excubitor)

### 選定根拠 (実測ベンチ 2026-07-10)

Vestigium 形式 60 万行 / 155MB / 3 日分 / 6 サービス。 Windows 11 / Node 24 (負荷中の実機):

| エンジン | 取込 | 直近300(全体) | 直近300(1svc) | 期間集計 | retention | ディスク | RSS |
|---|---|---|---|---|---|---|---|
| SQLite 分離ファイル | 27.6s | 6ms | 4ms | 1,393ms | 14.9s (VACUUM) | 103MB | 294MB |
| LMDB 二重索引 | 288s | 6.7ms | 3.9ms | 241ms | 3.8s | 685MB | 282MB |
| DuckDB 取込型 | 3.4s | 41ms | 41ms | 5.3ms | 1.1s | 27MB | 89MB |
| **DuckDB JSONL 直読み** | 0 | 498ms | 332ms | 328ms | unlink | +0 | クエリ時のみ ~98MB |
| **DuckDB→Parquet** | 0.85s/日 | 64ms | 61ms | 16.6ms | unlink | **7.8MB (1/20)** | 変換時のみ ~92MB |
| 素朴 node スキャン | 0 | 1,113ms | 386ms | 343ms | unlink | +0 | 258MB |

- LMDB は取込・ディスクで脱落。 SQLite は retention コストと二重保存が残る
- 「取込型 DuckDB」 も優秀だが、 正本 (JSONL) との二重保存構造は変わらないため、
  直読み + Parquet 圧縮を採用。 ホット日 (当日) クエリ ~0.3-0.5s は
  on-demand の履歴調査用途では許容 (ライブ系はリングバッファが 0ms 側を担う)

## 3. アーキテクチャ

```
[各サービス] ──Vestigium SDK──▶ <logs>/<code>/YYYY-MM-DD.jsonl   (正本)
[Excubitor spawn 子] ─fd─▶ data/process-logs/<code>.{out,err}.log (クラッシュ安全な生ログ)
        │                                    │
        └── process-file tail ──▶ log bus ◀── file-tail (Vestigium JSONL)
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
        error-detector      リングバッファ (新)      Vestigium writer (新, Phase 3)
        (既存のまま)         SSE /logs · /logs/recent   stdout 系を JSONL 正本へ合流
                                                     (createWriter, channel=stdout/stderr)

[履歴クエリ] GET /api/v1/logs/query · MCP excubitor_query_logs (新)
   └▶ 遅延 DuckDB (クエリ毎に :memory: instance)
        ├─ 当日/未圧縮日: read_json_auto('<logs>/<code>/YYYY-MM-DD.jsonl')
        └─ 圧縮済み日:    read_parquet('<logs>/<code>/YYYY-MM-DD.parquet')
      日付レンジ → 対象ファイル名を事前に絞る (パーティションプルーニング)

[日次バッチ] (Excubitor 内 timer, 深夜)
   前日 JSONL → COPY TO 'YYYY-MM-DD.parquet' (ZSTD)
   → 行数照合 OK なら .jsonl 削除 (tmp 書き → rename の原子的置換)

[retention]
   JSONL: Vestigium sweeper (retentionDays, 既存)
   Parquet: Excubitor retention loop (catalog retention: に parquet_days 追加, 既定 90d)
   process-logs 生ファイル: サイズ上限ローテーション (新, 既定 32MB × 2 世代)
```

### 廃止するもの

- `service_instance_logs` への書き込み (log bus の `persistLine`)
- 同テーブルを読む `/logs/recent` の SQL 経路 (リングバッファ + 履歴クエリに置換)
- PR #65 の同テーブル向け retention (liveness_history 向けは残す)
- テーブル自体は 1 リリース据え置き後 DROP (ロールバック猶予)

### 残すもの

- SQLite (excubitor.sqlite): liveness / memory_samples / error_tasks / catalog 等の
  構造化データは引き続き SQLite。 **ログの行データだけが出ていく**
- error-detector / SSE の bus 購読モデル (無変更)
- Vestigium reader (tail CLI 等) はそのまま JSONL を読める

## 4. インターフェース変更

### HTTP API

- `GET /api/v1/logs/recent` — リングバッファから返す (互換維持、 DB を読まない)
- `GET /api/v1/logs/query` (新) — params: `codes`, `from`, `to`, `level`, `contains`,
  `limit` (≤5000)。 遅延 DuckDB で JSONL/Parquet を直読み
- `GET /api/v1/services/:code/logs` (SSE) — 無変更 (bus 直結)

### MCP

- `excubitor_recent_logs` — 無変更 (裏がリングバッファになる)
- `excubitor_query_logs` (新) — `/api/v1/logs/query` の薄いプロキシ

### catalog

```yaml
retention:
  liveness_hours: 168      # 既存 (liveness_history)
  logs_hours: (廃止)       # service_instance_logs 廃止に伴い削除
  parquet_days: 90         # Parquet の保持日数 (新)
log_store:
  ring_lines_per_service: 2000   # リングバッファ (新)
  ring_lines_global: 20000
  compact_hour_utc: 18           # JSONL→Parquet 日次バッチ (JST 深夜 3 時)
```

## 5. 実装フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| 1 | リングバッファ + `persistLine` 停止 + `/logs/recent` 付替え + `@duckdb/node-api` 導入 + `/api/v1/logs/query` (JSONL 直読みのみ) + MCP tool | recent/SSE/エラー検知が DB なしで従来同等。 query が当日 JSONL を返す |
| 2 | Parquet 日次バッチ + query の Parquet 経路 + parquet retention | 前日分が自動圧縮され、 過去日 query が Parquet から返る |
| 3 | stdout 系を Vestigium writer で JSONL 正本へ合流 + process-logs サイズローテーション | spawn 子のログが `<logs>/<code>/` に統一され query 対象になる |
| 4 | `service_instance_logs` DROP + 旧 retention 設定削除 | 1 リリース安定稼働後 |

Phase 1+2 を 1 PR、 Phase 3 を 1 PR、 Phase 4 は掃除 PR を想定。

## 6. リスクと対策

- **書き込み中 JSONL の読み**: 当日ファイルは追記中。 DuckDB の read は行単位で
  末尾不完全行があり得る → `ignore_errors=true` で読む (欠けるのは書きかけ最終行のみ)
- **変換とテールの競合**: 変換対象は「前日」ファイルのみ (UTC 境界越え後) で追記は無い。
  tmp → rename の原子的置換 + 変換後の行数照合で破損を検知
- **@duckdb/node-api 依存**: ネイティブ addon (~60MB)。 遅延生成なので常駐コストは無し。
  Windows/Node24 prebuilt はベンチで動作確認済み
- **クエリ同時多発**: instance はクエリ毎に生成・破棄 (stateless)。 同時実行上限 2 の
  セマフォを入れ、 溢れは 429
- **Vestigium との整合**: `.parquet` を `<logs>/<code>/` に同居させる。 Vestigium
  DESIGN §2.1 の圧縮枠 (`.jsonl.gz`, P2 未実装) の実現形として Parquet を採用する旨を
  Vestigium DESIGN.md に追記 (実装 PR と同時に Vestigium 側へ 1 行 PR)。
  Vestigium sweeper は `.jsonl` のみ対象のため衝突しない

## 7. 効果見込み

- Excubitor backend RSS: ログ由来分 (SQLite ページキャッシュ + WAL) がほぼゼロに
- ディスク: 日量 155MB 相当のログでも Parquet 化で ~8MB/日、 90 日保持で ~0.7GB
- retention: VACUUM 廃止。 ファイル unlink のみ (O(1))
- 検索性: 向上 (DuckDB SQL — 集計・LIKE・日付レンジ。 これまで recent 取得のみだった)
