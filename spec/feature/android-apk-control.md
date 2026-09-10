# Android APK service control

Android端末操作はExcubitorが所有する。Pictorはデモ集APKを生成し、Ergoへの依存は持たない。

サービス所有catalogにruntime: androidとandroid設定を宣言する。

```yaml
services:
  - code: pc-android-demos
    name: Pictor Android demos
    project_code: Pc
    runtime: android
    tier: local-app
    cwd: ${ARS_ROOT}/Pictor
    android:
      adb: ${ANDROID_HOME}/platform-tools/adb.exe
      serial: ${PICTOR_ANDROID_SERIAL}
      apk: build/android-demo/pictor-demos.apk
      package: com.ludiars.pictor.demos
      activity: .DemoActivity
    autostart: false
    restart_policy: 'no'
```

ADB実行ファイルはホストOSに合わせて指定する。端末serialは必須で、自動選択しない。既存のUSB接続またはADB接続済み端末を対象とする。無線ペアリング・ネットワーク探索・ADBサーバー終了は行わない。

既存HTTPサービスcontrolのstart/stop/restart、local-control CLIのstatusを使う。supervisorの既存キューと監査経路を通し、backendがアプリの所有者にならない。startはAPKをinstall -rしactivityを起動、stopは指定packageのみforce-stopする。restartでは入力を検証してから停止する。APKは実パスでサービスcwd配下に限定し、cwdの.gitがファイルであるlinked worktreeは拒否する。

statusはadb get-stateとpidofで確認する。pidは端末側のためホストPID欄へ入れない。接続・認証エラーはstoppedと区別する。起動成功はactivityのStatus: okと端末プロセスの存在までであり、画面描画の正しさを保証しない。

HTTPでの端末状態確認はGET /api/v1/services/:code/android-status。通常のサービス一覧のホストスキャン結果と区別し、supervisorから端末を照会する。

初期実装は明示操作のみ。Androidの自動起動・ホストプロセス監視・ポートkill・メモリ監視は提供しない。APK署名とpackage/activityの一致はAPKビルド側で管理する。実機テストでは既存のConcordia claim/release手順を守る。
