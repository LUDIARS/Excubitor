# supervisor Infisical identity 環境反映漏れ修正

- [x] `service-runner` が backend と別プロセスであることを確認する。
- [x] supervisor 起動前に暗号化設定の identity を `process.env` へ反映する。
- [x] identity 反映関数が呼ばれる回帰テストを追加する。
- [x] 指定された Vitest と TypeScript の検証を実行する (vitest 2 pass / tsc --noEmit green)。
