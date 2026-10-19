# Ex mesh 認証の実装作業

参照: actio:7a9649fb-f582-4082-b841-922ba798139b
仕様: [security-mesh-cr-auth](../feature/security-mesh-cr-auth.md)

- [x] 既存 peer/store/client/Vault/operations の再利用範囲を決定
- [x] 契約と設計を実装前に定義
- [x] Cr adapter・proof・peer migration・nonce 永続化
- [x] action/resource/Vault key 認可、artifact 検証
- [x] ブラウザ経由の管理 API guard
- [x] Augur plan の認可・境界入力・再送 abuse ケースを対のテストとして追加
- [x] 型チェックと差分検査
- [ ] Concordia commit、local PR、委託 status（結果の正本はCc）

Augur の log-only rollback 提案は採用しない。認証失敗時の許可拡大は禁止し、設定を訂正するまで拒否を維持する。テスト/起動/再起動は未実施とする。Cr wire contract、運用登録、TLS、鍵/旧鍵移行、Cc 側の AI 制限、管理 API credentials は移行時の別承認事項。

受け入れ契約:

- C-14 validateWorkloadClaims(input): Cr workload の主体・宛先・60秒以内の期限・Ed25519鍵を検査する
- C-15 permitsMeshAction(input): 完全一致のaction/resourceだけを許可しlegacyの高権限を拒否する
- C-16 selectVaultKeys(input): 許可された秘密キーだけを配布対象に残す
- C-17 verifyMeshProof(input): 要求・宛先・tokenを束縛したEd25519署名だけを認証する
- C-18 verifyArtifactDigest(input): 管理済みSHA256と一致するbundleだけを受理する

検証記録: `tsc --noEmit` 成功。Augur contract-wrap 5件注入。テスト/起動は未実行のため C-14〜C-18 は not-called。既存 C-1〜C-4 の predicate module 不在を lint で検出したが、対象外のため変更しない。

継続修正: 旧 API fixture が無設定の fail-closed503 と旧高権限 HMAC202を混同していたため、無設定拒否・明示legacy-monitorによる監視・legacy変更要求拒否・local管理CRUDへ分けた。正しいcr-v1認証は既存peer-authテストで維持する。Ex→Ccは専用concordia audienceで送信直前のtoken/proofを生成し、発行/鍵/設定失敗を送信前に拒否する。`/mcp`にもAPIと同じブラウザ境界を適用した。caller署名と失敗・設定・MCP境界の回帰ケースを追加し、全体の静的型検査と差分検査は成功。テストは実行していない。

PR2520のaction_required/human gateは維持。修正commit後も再審査・マージ・live設定は未実施。一般管理APIのCernere active-session移行は未実装であり、Host/Origin対策を管理API認証完了とは扱わない。

2026-10-07 17:06 JST、人間の隔離回帰テスト許可後にcc-test claim/release付きで実行。API/MCP境界、Cc caller、peer auth、config、browser guardの5 suiteが88/88成功。初回API fixtureの共有E:/tmp削除がEPERMだったためworktree内process別pathへ修正し、同じsuiteを再実行した。追加security directoryの9 suiteは23/23成功。LOG_WEAVER=1でC-14:1、C-15:9、C-16:1、C-17:10、C-18:4件のcontract observedを取得し、違反/predicate例外は0件。観測ログはworktree logs/security-regression-20261007/weaver.jsonl。全体型検査とdiff checkも成功。実サービス・production DB・live credentials・cutoverは未操作。

再利用: peer store と既存 operation runner/Vault を継続利用。共有 HMAC は移行中の監視だけに制限。契約観測は既存 Lapilli submodule の log-weaver を依存として追加し、暗号ライブラリの自作や project token の転用は行わない。Node Ed25519 primitive で要求 proof を実装する。

## 2026-10-09 移行で監視・Vault・運用を止めない (actio:b4c5bde3-fcda-47da-b528-6f9c0857ebb7)

- [x] PR2520 の action_required 理由 (api-routes の federation 試験が 401 期待で 503) は 47554d8 / f56a252 で fixture 分離済みであることを確認し、今回の変更後も同 suite を再実行
- [x] 移行用 legacy-monitor (明示コマンドで有効化、起動ログ・拠点メッシュ画面に警告、高権限は拒否) — [SPEC-SECURITY-MESH-LEGACY-MONITOR](../feature/security-mesh-cr-auth.md#SPEC-SECURITY-MESH-LEGACY-MONITOR)
- [x] Vault 一時障害時の控えによる起動、失効時の破棄、サービス単位の fallback 禁止 — [SPEC-VAULT-CACHE-FALLBACK](../feature/vault.md#SPEC-VAULT-CACHE-FALLBACK)
- [x] キュー待ち operation の再認可 (同じ範囲・digest で依頼元から取り直す) — [SPEC-SECURITY-MESH-REAUTHORIZATION](../feature/security-mesh-cr-auth.md#SPEC-SECURITY-MESH-REAUTHORIZATION)
- [x] bundle digest 承認の運用手順と、拒否時の digest / main commit の記録 — [SPEC-SECURITY-MESH-BUNDLE-APPROVAL](../feature/security-mesh-cr-auth.md#SPEC-SECURITY-MESH-BUNDLE-APPROVAL)
- [x] 管理画面 Host/Origin allowlist (既定は従来の厳しい検査) — [SPEC-SECURITY-BROWSER-ALLOWLIST](../feature/security-mesh-cr-auth.md#SPEC-SECURITY-BROWSER-ALLOWLIST)

再利用: cr-v1 要求の検証は peer-auth から `security/cr-request-auth.ts` へ切り出し、再認可の検証と共用した (暗号処理・introspection・nonce 永続化は既存のまま)。operation の action/resource 対応は `security/operation-scope.ts` に一本化した。Vault の控えは既存の `cacheEnv` / `cachedEnv` を使い、破棄 (`dropCachedEnv`) だけを追加した。通知は既存の Discord webhook 設定を再利用した。

未実施: サービスの起動・再起動、supervisor・拠点設定の変更、実 Vault・Cr への接続、移行コマンドの実行はしていない。frontend は worktree に依存が無く型検査していない。Augur 契約の追加・集計はしていない。

