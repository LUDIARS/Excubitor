---
task: breakaway-spawn-failure-distinction
project: Excubitor
kind: 実装
created: 2026-08-12
memory_links: []
---

# breakaway spawn の「即死」と「照合不能」を切り分ける

## 目的

`could not be verified after breakaway spawn (pid=...); it exited immediately or its identity
was unreadable` は、 性質の違う 2 つの失敗を 1 つの文言にまとめている。 対処が正反対
(前者は起動失敗の調査、 後者は生き残った pid の始末) なので、 呼び出し側とログで区別できる
ようにする。

## 背景

`spawnReservedService` は `waitForProcessIdentity` が null を返したときに fail-closed する。
コメントにも「verifyProcessIdentity は『即死した』と『照合できなかった』を区別しない」と
書かれている。現在は `recordSpawnFailure` が生存確認できた pid を `crashed` の行に残し、
boot 時の reconcile が再採用を試みるため、照合不能の pid を直ちに捨てるわけではない。
しかし呼び出し側へ返すエラーと警告ログは両方の失敗を 1 つにまとめており、起動失敗の調査と
生存 pid の確認・回収を区別して開始できない。

2026-08-08 に Concordia の再起動がこの文言で失敗したときは、 旧プロセスが port を握って
新プロセスが EADDRINUSE で即死したケースだった。 これは 2026-08-07 の port-guard
(`src/process/port-guard.ts`) で塞がれている。 塞がっていないのは、 それ以外の理由で
identity を読めなかった場合の見分けと後始末。

Memoria #789 の要対応 3 点のうち、 (2) 管理外プロセスの検知と復旧は port-guard と
`adoptDeclaredPortOwners` で、 (3) health 200 だけで健全と判定しない は port ownership 判定
(PR #476) で対応済み。 本タスクは残る (1) にあたる。

## 完了条件

- 「pid が既に存在しない (即死)」と「pid はあるが作成時刻を読めない (照合不能)」が別の失敗
  として区別され、 エラー文言とログの両方に出る。
- 照合不能の場合、 `recordSpawnFailure` による生存 pid の保持と boot 時の再採用方針を維持し、
  その pid を確認・回収すべきことがエラー文言とログから明確に分かる。
- design.md §17.4 の孤児検出手順と、 どちらの失敗がその手順の対象なのかが対応付いている。

## スコープ (編集可ディレクトリ)

- `src/process/identity.ts` — 判定結果に理由を持たせる
- `src/process/manager.ts` — 失敗の組み立てと孤児の扱い
- `spec/plan/design.md` — §17.4 との対応
