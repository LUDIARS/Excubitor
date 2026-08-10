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
2. 履歴クエリは JSONL だけなら**ストリームで直読み**し、 Parquet を含む場合だけ
   クエリ時に DuckDB インスタンスを開く (常駐 RSS ゼロ。 in-memory instance open 実測 38ms)。
   JSONL 経路は結果を `limit` 件に保ち、入力ファイル全体や全一致行をメモリに保持しない。
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
   ├─ 当日/未圧縮日のみ: JSONL をストリーム読取 (結果は limit 件のみ保持)
   └─ 圧縮済み日を含む: 遅延 DuckDB (クエリ毎に :memory: instance)
        ├─ JSONL:   read_json_auto('<logs>/<code>/YYYY-MM-DD.jsonl')
        └─ Parquet: read_parquet('<logs>/<code>/YYYY-MM-DD.parquet')
      日付レンジ → 対象ファイル名を事前に絞る (パーティションプルーニング)

[日次バッチ] (Excubitor 内 timer, 深夜)
   前日 JSONL → COPY TO 'YYYY-MM-DD.parquet' (ZSTD)
   → 行数照合 OK なら .jsonl 削除 (tmp 書き → rename の原子的置換)

[retention]
   JSONL: Vestigium sweeper (retentionDays, 既存)
   Parquet: Excubitor retention loop (catalog retention: に parquet_days 追加, 既定 90d)
   process-logs 生ファイル: サイズ上限ローテーション (新, 既定 32MB × 2 世代)
```

### [LOG-STORE-QUERY-JSONL] JSONL 専用クエリ経路

`src/log/query-engine.ts` は JSONL を DuckDB に渡さず、
`readline` によるストリーム読取で Vestigium レコードを検証・絞り込みする。時刻降順の
結果は `limit` 件だけを保持する。Parquet を含む対象は Parquet 部分だけを DuckDB で読み、
両経路の上位 `limit` 件をマージして最終的な上位 `limit` 件を返す。

### [SPEC-LOG-QUERY-PARTIAL-JSONL] 追記中 JSONL の部分行

当日 JSONL は末尾レコードの書き込み途中に履歴クエリされうる。JSONL 専用経路は
Vestigium レコードとして検証できない行を無視する。Parquet と JSONL の混在時も JSONL
部分には同じストリーム経路を使う。どちらも、それ以前の正常な履歴を末尾の部分行のために
失敗させず、JSONL ファイル全体をメモリへ読み込まない。

### process-logs サイズ上限ローテーション (Phase 3 の前半、 実装済み)

実装は `startProcessLog()` / `rotateIfOversized()` / `maxLogBytes()` @ `src/log/process-file.ts`。

- 上限は `EXCUBITOR_PROCESS_LOG_MAX_MB` (既定 32MB)。 不正値・0 以下は既定へフォールバック。
- 判定と退避は **open 時のみ** (= サービス起動/再起動)。 稼働中の子は fd を直接持つため、
  走行中の rename/truncate は Windows で安全に行えない (rename 後も子は旧 inode へ書き続け、
  truncate は sparse file を作る)。 長期稼働サービスは再起動のたびに上限へ丸められる。
- 世代は現行 + `<file>.1` の 2 世代。 旧 `.1` は破棄する。
- 退避に失敗しても spawn は止めない (append 継続が最優先)。 warn ログのみ。
- `.1` は ProcessLogTail の対象外のため、 退避時に tail 未読の行は取りこぼす。
  上限が tail の追従速度より十分大きい前提で許容する。
- catalog の `code` は未検証文字列 (リポ断片 YAML 由来) なので、 rm/rename する破壊的
  経路であるローテーションはログ dir 直下のパスに限定する。

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
  `limit` (≤5000)。JSONL のみはストリーム読取、Parquet を含む場合は遅延 DuckDB で直読み
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

- **書き込み中 JSONL の読み**: 当日ファイルは追記中。JSONL 専用経路は Vestigium
  レコードとして検証できない末尾不完全行を無視する。Parquet との混在時も JSONL 部分は
  同じストリーム経路を使う (いずれも欠けるのは書きかけ最終行のみ)
- **変換とテールの競合**: 変換対象は「前日」ファイルのみ (UTC 境界越え後) で追記は無い。
  tmp → rename の原子的置換 + 変換後の行数照合で破損を検知
- **@duckdb/node-api 依存**: ネイティブ addon (~60MB)。 遅延生成なので常駐コストは無し。
  Windows/Node24 prebuilt はベンチで動作確認済み
- **クエリ同時多発**: JSONL ストリーム読取と DuckDB 経路のいずれも stateless。 同時実行
  上限 2 のセマフォを入れ、 溢れは 429
- **Vestigium との整合**: `.parquet` を `<logs>/<code>/` に同居させる。 Vestigium
  DESIGN §2.1 の圧縮枠 (`.jsonl.gz`, P2 未実装) の実現形として Parquet を採用する旨を
  Vestigium DESIGN.md に追記 (実装 PR と同時に Vestigium 側へ 1 行 PR)。
  Vestigium sweeper は `.jsonl` のみ対象のため衝突しない

## 7. 効果見込み

- Excubitor backend RSS: ログ由来分 (SQLite ページキャッシュ + WAL) がほぼゼロに
- ディスク: 日量 155MB 相当のログでも Parquet 化で ~8MB/日、 90 日保持で ~0.7GB
- retention: VACUUM 廃止。 ファイル unlink のみ (O(1))
- 検索性: 向上 (DuckDB SQL — 集計・LIKE・日付レンジ。 これまで recent 取得のみだった)
