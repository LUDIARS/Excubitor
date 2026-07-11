---
title: Safe operation monitoring
description: Excubitorが提供する安全稼働監視と追加導入候補。
---

# Safe operation monitoring

## 実装済みの監視契約

- health probe結果を`liveness_history`へ追記する。
- 連続ダウンが設定閾値（最小60秒）を超えたらDiscordへ1回だけ通知する。
- 通知済みincidentの復旧を通知し、incident状態を閉じる。
- Webhook失敗は30秒以上空けて再試行し、URLは暗号化保存・API非返却とする。
- ログerror taskは未解決中に同じrule/serviceで集約する。
- Concordiaへのcrash Issue委譲は失敗・stuckを永続状態から再照合し、重複runを避けて再試行する。

## 次に導入する監視

優先順は以下とする。

1. **外部dead-man監視**: Excubitor自身が停止すると自己通知できないため、別プロセスまたは外部uptime
   monitorから`/health`を監視する。
2. **health freshness**: サービスのup/downだけでなく、scanner tick自体が60秒以上更新されない状態を通知する。
3. **crash-loop/restart storm**: 一定時間内のrestart回数、同じfatal errorの再発、PID churnを集約通知する。
4. **容量枯渇**: SQLite/WAL、Vestigium、process logs、ディスク空き容量を監視し、retention失敗も通知する。
5. **通知経路監視**: 定期canary通知と最後の成功時刻を保持し、Webhookが長期間使えない状態を別経路へ通知する。
6. **synthetic check**: port/processだけでなく、主要APIの認証なしread-onlyシナリオを実行して機能停止を検出する。
7. **証明書・secret期限**: TLS証明書、Infisical identity、外部API tokenの失効前通知を行う。

通知にはalert fingerprint、開始時刻、直近health detail、関連ログへの参照、復旧時刻を含め、
同一incidentの重複通知を禁止する。
