# AWS 計算ジョブ

仕様 ID `SPEC-EX-AWS-COMPUTE`。Actio `actio:c89d70cd-243d-4676-a956-b6ae5569118c`。

Excubitor は登録された EC2 インスタンスと ECS Fargate タスクの起動、照会、停止、解放を担う。Concordia は依頼の受理、予算、試行、成果物の回収と検収を担う。AWS の計算用 API は拠点メッシュのピア操作から独立する。

## 管理者の登録項目

WebUI「環境変数」で、下表のキーを共有 Vault に登録する。AWS への署名は Excubitor 内で行い、15 分の STS セッションは有効期限までメモリに保持し、期限の 60 秒前から更新する。キーを変更するとキャッシュを破棄する。準備状態 `credentials.configured` は Vault 値の存在と形式を表す。権限や有効期限は実際の AWS API 呼び出しで判定する。

| Vault キー | 値 |
|---|---|
| `EX_AWS_COMPUTE_ACCESS_KEY_ID` | 専用の AWS 主体のアクセスキー ID。 |
| `EX_AWS_COMPUTE_SECRET_ACCESS_KEY` | 同じアクセスキーのシークレット。 |
| `EX_AWS_COMPUTE_ROLE_ARN` | STS で引き受ける計算操作ロールの ARN。省略時は登録した主体に計算操作の権限が必要。 |
| `EX_AWS_COMPUTE_SESSION_TOKEN` | 一時資格情報を登録する場合のみ、そのセッショントークン。更新は管理者が行う。 |
| `EX_AWS_COMPUTE_EXTERNAL_ID` | ロールの信頼ポリシーが要求する場合のみ、同じ External ID。 |

WebUI「AWS 計算」で実行先と runner を登録する。対象ごとの同時実行は 1、AWS への投入は 1 試行、`maxRuntimeSeconds` は 60 秒〜7 日。`orphanPolicy` の既定値は `report`。未解放のジョブがある実行先は更新・削除できない。商用 AWS パーティションのリージョンを扱う。

| 実行先 | 必須設定と AWS 側の準備 |
|---|---|
| EC2 | `image` に AMI ID または launch template ID と数値版を指定。インスタンスタイプ、サブネット、セキュリティグループと必要な場合はインスタンスプロファイル ARN を設定。Linux AMI に cloud-init と `shutdown`、信頼済みの実行ファイルを用意する。runner に実行ファイルの絶対パス、固定引数、入力キーを登録する。テンプレートや AMI の EBS は、残す必要があるものを除き `DeleteOnTermination` を設定する。 |
| Fargate | クラスター ARN、revision 付きタスク定義 ARN、サブネット、セキュリティグループ、`assignPublicIp` を設定。Linux、`awsvpc`、`FARGATE` と、各コンテナの `stopTimeout`（2〜120 秒）をタスク定義に明記する。runner にコンテナ名、固定コマンド（省略時はタスク定義）、入力キーを登録する。タスク実行ロールとタスクロールに、そのイメージ・ログ・入出力の権限を与える。 |

ジョブ入力には非秘密の値だけを送る。入力キーには runner がデータとして扱う変数だけを登録する。実行ランタイムを変更する変数（`PATH` や `LD_PRELOAD` など）や資格情報の変数は登録しない。ジョブ入力は SQLite に投入待ちの間だけ保存する。AWS に渡した入力は EC2 の user-data や ECS の overrides に残り得る。

### IAM 設定例

以下は `us-east-1` の AMI 直接指定と ECS クラスター 1 個の例。アカウント、実行先の ARN、ロール、`EXCUBITOR_OWNER` を実値に置き換える。owner は実行先一覧 API の `owner` に表示する。片方の実行先だけを使う場合は該当する文だけを登録する。`iam:PassRole` は登録した AWS 実行ロールが必要な場合だけ許可する。EC2 インスタンスプロファイルを使う場合は配下のロールに絞り、`iam:PassedToService` を `ec2.amazonaws.com` に設定する。テンプレートを使う場合は該当テンプレート ARN と、版が参照するイメージ・ネットワーク・ディスク等に権限を絞る。テンプレートの追加タグに必要な作成時の許可も確認する。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ec2:DescribeInstances", "Resource": "*", "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } } },
    { "Effect": "Allow", "Action": "ec2:RunInstances", "Resource": [
      "arn:aws:ec2:us-east-1::image/ami-0123456789abcdef0",
      "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123456789abcdef0",
      "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0",
      "arn:aws:ec2:us-east-1:123456789012:network-interface/*",
      "arn:aws:ec2:us-east-1:123456789012:volume/*"
    ] },
    { "Effect": "Allow", "Action": "ec2:RunInstances", "Resource": "arn:aws:ec2:us-east-1:123456789012:instance/*", "Condition": { "StringEquals": { "aws:RequestTag/ludiars:owner": "EXCUBITOR_OWNER", "ec2:InstanceType": "t3.micro" } } },
    { "Effect": "Allow", "Action": "ec2:CreateTags", "Resource": "arn:aws:ec2:us-east-1:123456789012:instance/*", "Condition": { "StringEquals": { "ec2:CreateAction": "RunInstances", "aws:RequestTag/ludiars:owner": "EXCUBITOR_OWNER" } } },
    { "Effect": "Allow", "Action": "ec2:TerminateInstances", "Resource": "arn:aws:ec2:us-east-1:123456789012:instance/*", "Condition": { "StringEquals": { "aws:ResourceTag/ludiars:owner": "EXCUBITOR_OWNER" } } },
    { "Effect": "Allow", "Action": "ecs:DescribeTaskDefinition", "Resource": "*", "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } } },
    { "Effect": "Allow", "Action": "ecs:ListTasks", "Resource": "*", "Condition": { "ArnEquals": { "ecs:cluster": "arn:aws:ecs:us-east-1:123456789012:cluster/compute" } } },
    { "Effect": "Allow", "Action": "ecs:DescribeTasks", "Resource": "arn:aws:ecs:us-east-1:123456789012:task/compute/*" },
    { "Effect": "Allow", "Action": "ecs:RunTask", "Resource": "arn:aws:ecs:us-east-1:123456789012:task-definition/compute:3", "Condition": { "ArnEquals": { "ecs:cluster": "arn:aws:ecs:us-east-1:123456789012:cluster/compute" }, "StringEquals": { "aws:RequestTag/ludiars:owner": "EXCUBITOR_OWNER" } } },
    { "Effect": "Allow", "Action": "ecs:TagResource", "Resource": "arn:aws:ecs:us-east-1:123456789012:task/compute/*", "Condition": { "StringEquals": { "ecs:CreateAction": "RunTask", "aws:RequestTag/ludiars:owner": "EXCUBITOR_OWNER" } } },
    { "Effect": "Allow", "Action": "ecs:StopTask", "Resource": "arn:aws:ecs:us-east-1:123456789012:task/compute/*", "Condition": { "StringEquals": { "aws:ResourceTag/ludiars:owner": "EXCUBITOR_OWNER" } } },
    { "Effect": "Allow", "Action": "iam:PassRole", "Resource": ["arn:aws:iam::123456789012:role/ComputeTaskExecution", "arn:aws:iam::123456789012:role/ComputeTask"], "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } }
  ]
}
```

`AssumeRole` を使う場合は、最初の主体に次のポリシーを付与し、操作ロールの信頼ポリシーでその主体だけに `sts:AssumeRole` を許可する。External ID を使う場合は信頼ポリシーに `sts:ExternalId` 条件を追加する。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::123456789012:role/ExcubitorCompute" }
  ]
}
```

[EC2 の IAM ポリシー例](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ExamplePolicies_EC2.html) と [ECS の IAM アクションと条件](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html)。

## API と状態

ベースパスは `/api/v1/aws-compute`。既存の Ex 管理 API のブラウザーガードに加え、ループバックソケットと宛先を確認する。転送ヘッダー付きの要求とクロスオリジン要求は拒否する。HTTP MCP `/mcp` では同じ条件を満たすクライアントにツールを登録する。stdio MCP は同じ API を呼ぶ。

| HTTP | 入出力または MCP |
|---|---|
| `GET /targets` | 対象設定、サイト owner、Vault の準備状態。 |
| `PUT /targets/:id` / `DELETE /targets/:id` | 対象設定の保存・削除。設定とジョブ台帳は Ex の SQLite に保存する。 |
| `POST /jobs` | `{target_id, job_id, runner, inputs, deadline}` を入力。入力は登録されたキーから文字列値を渡し、`deadline` はタイムゾーン付き ISO 8601。受理時は `202` と `operation_id` を含む受領情報。完全一致の再照会は `200` で同じ ID、同一 `job_id` の異なる入力と実行先の占有は `409`。MCP `excubitor_aws_compute_submit`。 |
| `GET /jobs/:id` | ジョブ状態、AWS 資源 ID、観測時刻、Fargate のコンテナ別終了コード、解放状態。MCP `excubitor_aws_compute_status`。 |
| `POST /jobs/:id/cancel` | 停止要求を永続化し、受理時は `202`。起動前は破棄し、起動後は同じ資源の停止を要求する。MCP `excubitor_aws_compute_cancel`。 |
| `GET /jobs?active=true&limit=50&offset=0` | ジョブ一覧。`active` の既定は `false`。MCP `excubitor_aws_compute_list`。 |
| `GET /orphans` | 最後に完了した棚卸しの時刻、期限切れ件数、エラー件数と各資源への操作。 |

投入前にジョブ ID、入力の指紋、AWS 用のトークンを予約し、送信開始を SQLite に保存する。EC2 `ClientToken` と ECS `clientToken` / `startedBy` に同じトークンを使い、受領情報には `operation_id` を返す。資源には `ludiars:owner`、`ludiars:operation-id`、`ludiars:target-id`、`ludiars:job-id`、`ludiars:expires-at` を設定する。応答喪失や送信途中の再起動では `unknown` とし、EC2 のトークンとタグ、ECS の `startedBy` とタグで照合を続ける。停止済み ECS タスクは周期棚卸しでも照合する。自動再投入は行わない。照合先の消失や権限不足で終端状態を確認できない間は占有を維持する。運用者はアカウント、リージョン・クラスター、タグ、AWS 側の履歴を照合する。

停止要求を `requested` として残し、後続の `DescribeInstances` / `DescribeTasks` が終端状態を返した時点で `confirmed` にする。起動前の破棄や確定拒否は `not_allocated`。Ex の監視は投入期限と対象最大時間の早い方に停止を要求する。停止までの遅延には API 応答時間と Fargate の停止猶予が加わる。EC2 の user-data は runner に先立って絶対期限から `shutdown -h +N` を設定し、Linux の分単位に切り下げる。runner の終了時にもシャットダウンし、EC2 のシャットダウン動作を `terminate` に設定する。Fargate の `stopTimeout` は停止要求後の猶予であり、総実行時間の制限は Ex の監視が行う。Ex が停止中、AWS に到達不能、または操作資格が失効している場合は、Fargate の期限内停止を保証できない。EC2 も cloud-init が起動しない場合は Ex の監視に依存する。

棚卸しは登録済み EC2 リージョン・ECS クラスターを巡回し、自サイト owner と有効な資源タグがそろった期限切れ資源を報告する。`terminate` は現在の設定と資源を再照会してから停止を要求する。対象の削除や移動の前に、旧リージョンまたはクラスターに残存資源がないことを AWS で確認する。ローカルの台帳と owner を維持し、AWS の資格情報は同じ資源を照会・停止できる主体へ入れ替える。EC2 の終端確認はインスタンスの状態を示す。保持を設定した EBS、ログ、成果物の費用と削除は運用側で管理する。

[EC2 RunInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html)、[ECS ListTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html)、[ECS の stopTimeout](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)。

## 受け入れ契約

```text
C-29 resolveDeadline(deadline, now, maxRuntimeSeconds): 過去の期限を拒否し実効期限を対象の最大実行時間以内に制限する
C-30 selectRunnerInputs(allowed, inputs): 登録済みキーだけをワーカーに渡す
C-31 nextJobAction(job, now): 送信開始を記録したジョブは再起動後も照会だけで復旧する
C-32 isExpiredOwnedResource(tags, owner, now): 所有者が一致し期限を過ぎた計算資源だけを棚卸し対象にする
C-33 toJobReceipt(job): 入力やトークンを公開せず観測結果と解放状態を別々に返す
```

検証はインメモリ SQLite と固定時刻、偽 AWS transport で行う。署名、Query/XML、STS、Fargate の限定された overrides と終了コード、冪等な予約、応答不明からの復旧、期限と停止の再照会、棚卸し、ループバック境界を単体テストで確認する。
