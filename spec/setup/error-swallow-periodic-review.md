---
title: Error swallow periodic review
description: AIFormatを正本として各サービスの例外握りつぶしを週次レビューし、指摘をGitHub Issueへ残す運用。
---

# Error swallow periodic review

## 目的

Excubitorのcatalogに登録された各リポジトリを週1回レビューし、例外・Promise rejection・
外部I/O失敗が無音で握りつぶされていないことを確認する。正本は次のAIFormat文書とする。

- `AIFormat/RULE_CODE.md` §7、§7.1、§9、§11、§15
- `AIFormat/common/REVIEW_CODE_QUALITY.md`
- `AIFormat/RULE_SRE.md` §2

## 定期実行契約

正本のschedulerは、毎日5:07 JSTに動くclaude.aiリモートルーティン
`ludiars-review-daily`（trigger `trig_01QHgXWxTbLSsMWXoTHKAUq4`）とする。手動実行時は
`/ludiars-review`を使う。同じremoteを持つworktree/cloneは1リポジトリとして扱う。

レビュー指示には以下を必ず含める。

1. 空catch、理由コメントのないbest-effort catch、`.catch(() => {})`、floating Promiseを列挙する。
2. fallback/no-op/mockへ無言で縮退する経路、通知・監視・health失敗を成功扱いする経路を確認する。
3. `console`直書きではなく共有logger/Vestigiumで、サービス名・操作・失敗理由が追跡できるか確認する。
4. 誤検知は「なぜ握りつぶしてよいか」と終了条件をレビュー記録へ残す。
5. High以上、または運用障害を隠す指摘はGitHub Issueにし、`file:line`、再現条件、影響、推奨修正を記載する。
6. このカテゴリは自動修正しない。レビュー成果物はCastraの
   `Review/<repo>/<YYYY-MM-DD>/REVIEW_IMPLEMENTATION.md`と`Review/<repo>/latest.json`に保存する。

## 定期実行ジョブ

Concordiaのrule engineは発火判断を記録する仕組みであり、`instructions`そのものを作業として
実行しない。したがってtick ruleだけを登録してレビュー済みとみなしてはならない。

リモートルーティンとローカル`ludiars-review` skillの両方に、次の指示を保持する。
起動要求、GitHub Issue作成、Castraへのpushのいずれかが失敗した場合は成功扱いにせず、
同じリポジトリを再試行対象に残す。Concordiaのtick ruleは実行器の代替にはしない。

```text
LUDIARS orgのリポジトリをremote URLで重複排除する。
Review/<repo>/latest.jsonが7日より古い対象を優先する。
AIFormat/RULE_CODE.md、common/REVIEW_CODE_QUALITY.md、RULE_SRE.mdに従い、
例外の握りつぶしをread-onlyレビューする。High以上はGitHub Issueへ記録し、
レビュー成果物をCastraのReview/<repo>/<date>/へ保存する。このカテゴリではコード本体を変更しない。
```

実行ジョブの成功条件は、対象リポジトリについてCastraに当日付の
`REVIEW_IMPLEMENTATION.md`と妥当な`latest.json`が存在し、High以上のIssue作成が完了していることとする。

## 監視

- 8日以上レビューされていないリポジトリは「review scheduler stale」として通知対象にする。
- リモートルーティン停止中は未レビュー対象を失わず、復旧後に古い対象から再開する。
- GitHub Issue作成失敗はレビュー成功に含めず、再試行可能な失敗として記録する。
