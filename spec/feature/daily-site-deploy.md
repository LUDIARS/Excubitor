# 拠点の日次更新 {SPEC-EX-DAILY-SITE-DEPLOY}

neco の 2026-10-06 指示: 各拠点で毎朝全 repository を pull、変更サービスを build/deploy、起動失敗時は前版へ戻し、復旧失敗は通知する。

## 設計

- 拠点ローカル DB に有効/無効、時刻、IANA timezone を保存する。既定は無効・06:00・拠点の timezone。設定の保存は実行を開始しない。各拠点の設定画面で操作する。
- persistent supervisor がタイマーと復旧を所有する。backend の停止に影響されない。safe mode は実行しない。同じ現地日付に一度だけ実行し、過去日の追いつき実行はしない。
- ARS_ROOT 直下の通常 checkout を列挙する。worktree、隠しディレクトリ、symlink は除く。共有 main の編集やローカルコミットは破壊しない。clean・追跡 branch・fast-forward 可能な checkout のみ更新し、それ以外は理由を履歴に残す。
- repository ごとに直列。fetch で変更を確認してから、旧 commit・旧 catalog 定義・各サービスの稼働状態を durable journal に保存し、稼働中のサービスを停止する。同じ repository のサービスをまとめて取り扱う。未変更 repository は再ビルド・再起動しない。
- 新版の依存・ビルド・catalog を検証して起動する。停止中だったものは停止状態のまま。稼働状態が判定できない/制御できない runtime がある repository は変更しない。
- 失敗時は部分起動を停止し、HEAD が保存した旧版または取得した新版であることと作業ツリーの安全性を検証して旧版へ戻す。submodule・依存・ビルドを復元して旧定義で再起動する。git の競合や外部変更は強制破棄しない。DB/サービスデータの巻き戻しは行わない。
- interrupted journal は次回 supervisor 起動時に復旧する。復旧失敗では error 履歴と通知を残して自動更新を無効化し、繰り返し更新を避ける。Discord 未設定/送信失敗も履歴で明示する。
- Ex backend 自体は最後に更新する。復旧担当 supervisor は旧コードのまま存続させる。supervisor の版更新には既存の OS service lifecycle を用い、復旧 journal を残したまま自己終了しない。日次更新履歴に supervisor-restart-required を明示し、全体完了とは扱わない。
- 自動更新中は手動の変更操作と排他し、読み取りは維持する。スケジュール設定や health 読み取りで probe、build、git 操作を実行しない。

## 受入条件

無効時無操作、日付/timezone/DST の重複防止、同一 repo 集約、dirty/ahead/分岐の保護、停止状態保持、更新後の起動確認、旧版復旧、復旧失敗通知、途中終了復旧、手動操作との排他を検証する。実拠点の設定を勝手に有効化しない。

## 調査根拠

local main a452f60。Anatomia plan (no-llm) は update/service-startup/frontend-ui を選択。where は catalog/federation も関連として選択。test-suggestions は主経路・API契約・不正入力を提案し、追加したテストに反映。verify (transaction.ts) は rule_conformance/duplication/spec_linkage/coupling_delta/convention_drift PASS。Pf の登録仕様一覧には日次更新仕様なし。既存 service-operation は build/restart までで rollback なし。Actio の Ex task 一覧に対応 task は未取得（状態 unknown）。typescript-language-server は実行環境の PATH に無いため LSP 呼出は未実施。
