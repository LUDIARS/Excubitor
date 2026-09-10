---
task: android-apk-service-control
project: Excubitor
kind: 実装
created: 2026-09-10
memory_links:
  - spec/feature/android-apk-control.md
---
# Android端末上のAPKをExcubitorから制御する
## 目的
AndroidのAPK導入・起動・終了をExcubitor自身の責務とし、PictorやErgoにADB操作実装を持たせない。
## 完了条件
- サービス所有catalogでADB・端末・APK・package/activityを指定できる。
- 既存HTTP/CLIからsupervisorを経由して導入・起動・終了・状態確認を実行できる。
- 未接続・未認証・APK欠落・起動失敗を明示し、端末選択とプロセス確認を省略しない。
- worktreeから起動せず、ADB子プロセスを有限時間・出力上限付きで所有する。
## スコープ (編集可ディレクトリ)
src/android/、src/catalog/、src/control/、src/local-control/、spec/feature/。
