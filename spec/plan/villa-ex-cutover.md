# Villa の Ex 切替準備と実施条件

調査日: 2026-09-09。旧管理元は `Villa/excubitor.catalog.yaml` の villa、移行先は Ex 統合 Viewer の `src/villa/documents.ts` と `villa/`。

## 資料差分の確認結果

レビュー修正を含む統合 Viewer 版の routes は10種類の HTML を参照する。旧 Villa と SHA-256 を比較し、一覧 index.html を除く9種類は同一だった。一覧の差はレビューで除外資料へのリンクを削った変更である。旧一覧を丸ごと同期して復元しない。

移行対象は index、Cc manual、skill migrations、service graph、session cost methodology、MagicChronicle index/final review、Symphony Kill Chord index/final summary/market score。routes の末尾 slash 別名を維持する。

session-costs 本文、project-costs の固定集計、Pagus 解析群はレビューで除外済み。旧資料の再コピー・公開対象への復帰はしない。JSON マニフェストや villa-state.json は HTML 専用配信へ移さない。旧 /map の機能は Calliope へ移設済みであり復活させない。

## 切替先の前提

確認時の Ex 本体 main には `src/viewer/` と `villa/` がなく、統合 Viewer の PR #1618 の内容は未反映だった。タスク文書 PR #1621 の反映は Viewer 本体の配備を意味しない。#1618 の必要版を本体へ反映する工程が先に必要。

旧 catalog の autostart は既に false。これだけで停止済み・無効化済みとはしない。新経路を確認する前に旧プロセスを停止しない。

## 公開経路の切替方式

新資料 URL は Ex `/villa/<旧path>` から `/viewer/apps/villa/<旧path>` に転送される。Ex のルート `/` は Monitor であり、旧 Villa hostname の backend port だけ Ex に差し替えても、旧 `/skills` 等が自動で資料経路になるわけではない。

実際の旧 hostname と現行 ingress を、Ex の許可済み Tunnel 管理 API または管理正本から読み取り、次の経路を具体化してから変更する。

- 推奨: 旧 hostname の該当資料 URL を Ex の正規 URL `/villa/<path>` へ redirect。query を保持し、除外資料は公開しない。旧 origin に Ex の管理 API を公開しない。
- 旧 hostname を維持して proxy する必要がある場合: 明示的な path rewrite と資料パス限定が必要。単純な ingress の service 値への path 追記だけで成立すると仮定しない。

現行 hostname、許可範囲、入口認証を確認できるまでは公開経路を変更しない。秘密情報は手順書・ログ・添付へ出さない。

## 実施手順と復旧

1. #1618 の本体反映を明示許可の下で行う。既存未コミット変更は上書きしない。配布物に frontend/dist と villa が含まれることを確認する。
2. 現行公開経路と戻し先を記録。今回の10種類と routes を維持し、除外資料を復活させない。
3. 明示許可された動作確認は Concordia testing claim 後に、本体フォルダで行う。必要な起動/再起動は Ex 経由。/villa/ と代表 route、除外 route の非公開、入口認証を確認する。
4. 旧 URL の redirect または限定 rewrite を適用し、旧リンクの到達確認を行う。失敗時は公開経路を記録した旧値へ戻し、旧 Villa を残す。
5. 到達確認後、Ex 経由で旧 villa を停止。所有 catalog を `disabled: true` にする変更は Villa 側 worktree/PR で管理し、`autostart: false` を維持する。旧資料は削除しない。
6. testing release、配送確認付きで結果を共有する。復旧時は catalog の変更を管理経路で戻し、Ex 経由で旧サービスを起動して入口を戻す。

## 今回の到達点

切替対象資料の差分確認と除外整理、経路変換の必要性、反映・復旧手順まで具体化した。公開入口変更・サービス停止は未実施。#1618 のマージ/main 反映には既存の明示許可ルールが適用されるため、切替依頼だけを根拠に未マージ版を本体へコピーしない。
