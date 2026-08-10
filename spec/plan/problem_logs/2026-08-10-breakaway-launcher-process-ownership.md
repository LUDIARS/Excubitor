# breakaway launcher のプロセス所有権を証明できない回帰

- Date: 2026-08-10
- Status: unresolved
- Area: process / breakaway spawn / service lifecycle
- Severity: critical — 再起動が Ex 起動サービスとユーザー起動プロセスを安全に区別できない

## Summary

これは回帰である。2026-08-09 の breakaway launcher 修正は、launcher が早く終了して
子プロセスが起動前に失われる障害を扱った。しかし、cmd.exe 経由で起動したサービスでは
Ex が管理できる PID がラッパーに留まり、実サービスへの所有権を証明できない問題が残った。

Peregrinatio を Ex 経由で再起動すると、サーバーは http://127.0.0.1:8090 で listen
まで到達したが、Ex はラッパー PID を検証できず起動失敗として記録した。サービスとしての
稼働判定は起動者ではなく health で行う。Ex 外で起動された同一サービスも管理外
(unmanaged) として表示・監査し、health を継続監視する。stop / restart は宣言 port の
現在のプロセスを除去できる万能操作とし、管理外のゴーストを放置しない。

プロジェクトの運用ログは Vestigium (Vg) が正本である。stdout/stderr の pipe や
cmd.exe を存続させることを、ログ取得のためのプロセス所有権の代替にしてはならない。

## Evidence

- 2026-08-10、Cc の Ex 経由 peregrinatio restart は HTTP 409
  (implementation_service_failed) で失敗した。
- Ex audit log は次を記録した。

      service peregrinatio could not be verified after breakaway spawn (pid=26552);
      it exited immediately or its identity was unreadable

- 同じ起動の data/process-logs/peregrinatio.out.log には次が残った。

      Peregrinatio server on http://127.0.0.1:8090

  したがってアプリケーションの即時クラッシュではなく、Ex が持つ PID と実サーバーの
  同一性の問題である。
- src/process/manager.ts は runtime: node を shell 経由で起動し、breakaway launcher は
  その PID を採用する。npm run dev:server は cmd.exe → npm → tsx watch → node の
  多段起動となる。
- 2026-08-09-breakaway-launcher-kills-child.md は launcher の即時終了を避けるため、
  shell 経由に 750ms の起動猶予を導入した。この猶予は child の所有権を証明する仕組みではない。

## Regression Context

Windows の Scheduled Task Job Object からサービスを切り離すため、breakaway launcher が
導入された。launcher が child を起動し、結果ファイルで PID を返して終了する設計は、
cmd.exe などのラッパーが恒久的な親になる場合に、返却 PID がサービス実体を指すとは限らない。

過去の実装は stdout/stderr を維持するため cmd.exe をサービスの寿命まで残していた。
これは Ex がラッパーを掴んで連鎖終了できる一方、ログ pipe のために管理対象を引き延ばす
設計であり、Vg がログ正本である現在の契約と整合しない。

## Cause

主因は、サービスの生存確認 (health) とプロセスの起動元 (Ex 起動か管理外か) を分離して
いないことである。起動元は表示・監査のための状態であり、サービスとして扱うか、停止できるか
を決める条件ではない。

- health は endpoint が応答できることだけを示し、起動者を証明しない。だからこそ全サービスで
  必ず観測し、managed / unmanaged とは別軸の healthy / unhealthy 状態にする。
- port は同一プロトコルのユーザー起動プロセスにも使われ得る。これは stop / restart の対象を
  宣言 service に紐付けて表示・監査する理由であり、管理外のゴーストを残す理由にはしない。
- launcher が返すラッパー PID は、実サービスが子・孫プロセスへ移る構成では安定した
  管理 ID にならない。

## Fix Requirements

1. Ex は cmd.exe、stdout/stderr pipe、またはログ用ラッパーの存続を所有権の根拠にしない。
   診断用の process log は Vestigium の代替にしない。
2. 起動元は managed / unmanaged の状態として記録する。Ex 外で起動されたものも service として
   health を監視し、管理外だからといって ghost process を放置しない。
3. stop / restart は宣言 port の現在の listener process とその tree を停止できる万能操作にする。
   managed / unmanaged、healthy / unhealthy の事前状態と、停止後の health / listener 不在を
   audit する。
4. Windows Job Object 下の Ex 再起動後にも、Ex 起動プロセスは再照合できること。PID 再利用は
   起動時刻その他の識別子で必ず除外する。一致しない listener は unmanaged として継続監視する。
5. launcher が短命でも、サービス実体の起動契約・PID・識別情報を曖昧にしない。
6. npm / watch / daemonize のように entry PID と実体が分かれるコマンドは、管理対象の
   常駐サービスとして受理する契約を明文化する。
7. catalog 上の運用ログは Vg を正本とし、process stdout/stderr は失敗診断に限る。

## Verification

この記録作成時点では新たなテストは実行していない。実装時には少なくとも次を追加・確認する。

- Ex 起動の直接実行プロセスを start / restart / stop し、PID と作成時刻を用いた所有権
  照合が維持されること。
- 同じ port をユーザーが手動で使用している場合、health が確認され service state が unmanaged
  になること。stop / restart がその process tree を除去し、停止後 health と listener 不在を
  確認すること。
- launcher / Ex の再起動後、Ex 起動プロセスは再採用し、外部起動プロセスは unmanaged として
  health を継続監視すること。
- cmd.exe → npm → child のように所有権を証明できない entry は fail-fast で拒否するか、
  明示された安全な実行契約へ変換されること。
- 実地確認は Cc testing claim を取得し、プロジェクト本体から Excubitor 経由で行い、
  TestWorkflow フォーラムへ結果を記録すること。

## Follow-up

- [Fable decision packet](../breakaway-launcher-process-ownership-fable-packet.md) で、
  プロセス所有権の正本となるサービス契約を提案・選定する。
- 既存の fix/resolve-executable-instead-of-shell と fix/breakaway-node-shell の作業は、
  この不変条件と照合してから採否を決める。
