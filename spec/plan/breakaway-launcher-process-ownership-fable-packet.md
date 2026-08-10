# Fable Decision Packet: Ex のサービス・プロセス所有権

## 依頼

Excubitor (Ex) が Windows 上の常駐サービスを安全に start / restart / stop するための
プロセス所有権サービス契約を 1 つ提案してください。これは実装指示ではなく、採用する
アーキテクチャと移行順の判断依頼です。

詳細な障害記録は
[problem_logs/2026-08-10-breakaway-launcher-process-ownership.md](problem_logs/2026-08-10-breakaway-launcher-process-ownership.md)
を正本とします。

## 事実

- Ex は Windows Scheduled Task の Job Object 内で動く。サービスをその Job から切り離すため、
  WMI で短命 launcher を起動している。
- launcher は child の PID を返して終了する。しかし shell / cmd.exe / npm / watch が
  child を多段化すると、その PID は実サービスの PID ではない場合がある。
- Peregrinatio では cmd.exe → npm → tsx watch → node の後段 Node が port 8090 で listen
  しても、Ex は先頭 PID を検証できず起動失敗にした。
- stdout/stderr の process log は Vg の代替ではない。ログのために cmd.exe や wrapper を
  常駐させることは禁じる。
- health / port は稼働の観測には使えるが、起動者・所有者を証明しない。port だけを根拠にした
  restart 時の kill は、ユーザー起動プロセスを誤って停止し得る。
- Ex 再起動後にも、それ以前に Ex が起動した対象だけを再採用・停止できなければならない。

## 非交渉要件

1. cmd.exe、stdout/stderr の pipe、ログ用 wrapper の存続を所有権の根拠にしない。
2. Ex が stop / restart できるのは、Ex 起動であることを durable に証明できる対象だけ。
3. health 成功・port 一致だけでは、管理外プロセスを kill しない。
4. PID 再利用、Ex 再起動、launcher 終了、サービスの多段起動を明示的に扱う。
5. Vg を運用ログの正本とし、process stdout/stderr は診断補助に限定する。
6. 所有権を証明できない command は黙って採用しない。fail-fast の設定エラーか、明示的な
   安全な起動契約へ変換する。

## 判断してほしい候補

### A. 直接実行のサービス契約

catalog が実行ファイルと引数を明示し、Ex / launcher が shell を使わず直接生成する。
返却 PID と creation time を durable に保存し、entry process が常駐することを契約にする。
watch / daemonize / npm wrapper は Ex 管理対象から除外または専用コマンドへ置換する。

### B. 常駐 service host を所有権の根拠にする契約

ログとは無関係の専用 host が child lifecycle と識別情報を保持し、Ex は host と明示的な
制御チャネルを通じて子を管理する。host を採るなら、単なる cmd.exe の置換ではなく、
再起動・再採用・停止権限をどの識別子で証明するかを定義する必要がある。

### C. health / port からの再発見

この案は管理外プロセスを識別できないため、そのままでは不採用である。採用可能にする
追加の証明情報がある場合だけ、その情報と失敗時の安全側動作を示してください。

既存の fix/resolve-executable-instead-of-shell と fix/breakaway-node-shell は候補実装であり、
採用決定ではありません。

## 返却してほしい提案

1. 採用案を 1 つ、および却下する案と理由。
2. ownership record の最小データモデル（PID 以外の識別子、保存場所、失効条件）。
3. start / health / restart / stop / Ex 再起動後の再採用、各フロー。
4. ユーザー起動プロセスと衝突した場合の安全側の挙動。
5. catalog の起動契約と、既存 npm / watch サービスの移行計画。
6. Windows 固有の Job Object・WMI・child process の失敗モード。
7. 実装を分割する repository / module と、回帰テストの最小セット。

提案は「起動できた」ではなく、誰がそのプロセスを停止してよいかを常に説明できることを
成功条件にしてください。

## Fable 5 の提案（2026-08-10、読み取り専用）

Fable 5 には本 packet と障害記録だけを渡した。実装・テスト・サービス操作は依頼していない。
以下は提案の要約であり、採用判断は Ex の通常レビューで行う。

### 推奨: 直接実行 + durable ownership record

Fable は候補 A を推奨した。catalog が shell 文字列ではなく、直接実行する program と
argv を明示する。launcher は Job 脱出のためだけに短命で存在し、shell なしで entry
process を生成してから PID、creation time、実行イメージパスを返す。Ex はこの情報を
永続化し、再照合できた場合だけそのプロセスを管理下に置く。

最小の ownership record は service_code、起動ごとの spawn_id、PID、creation_time、
正規化済み image_path、argv_hash、state、launch diagnostics から成る。state は
starting、verified、released、stale を持つ。

stop / restart / Ex 再起動後の再採用で Ex が操作してよい条件は、verified record と
現在の PID、creation time、image_path がすべて一致することだけである。不一致なら
stale 化して ownership_lost を返し、kill しない。health と port は稼働観測に限定する。

### 却下案

- 常駐 service host は、host 自身の所有権を再び証明しなければならず、単一障害点と
  常駐層の二重化を増やす。最終的な根拠は同じ ownership record に戻る。
- health / port による再発見は、ユーザー起動プロセスとの区別ができず不採用。

### port 衝突と migration

start 時に listener が ownership record と一致しなければ、Ex は kill せず
port_occupied_by_unmanaged_process として fail-fast にする。明示的な kill-port は
通常の stop とは分離した人間承認操作として audit する。

npm、watch、bat、start_script は常駐 entry が直接実行できる形へ移行する。shell が
必要な command は、明示的な直接実行契約へ変換できるまで catalog sync 時に設定エラー
または移行警告とし、暗黙に管理対象へ採用しない。

### 実装候補と検証

Fable は exec contract、ownership record、ownership verification、process tree、
breakaway launcher、manager、catalog schema、port scanner を責務別に分けることを提案した。
最低限、PID 再利用拒否、管理外の port 占有を無傷で 409 にすること、再起動後の一致 record
だけの再採用、shell command の fail-fast、entry 配下の child 入替えを含む stop を回帰
テストにする。

実装前に、Windows で creation time と image path を確実に採取できること、resident entry
が子を入れ替えても自ら常駐すること、Job 脱出状態を確認できることは別途検証する前提である。
