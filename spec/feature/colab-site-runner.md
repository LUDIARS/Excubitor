---
id: SPEC-COLAB-SITE-RUNNER
title: Colab 拠点ランナー
status: draft
---

Actio `actio:4317d91c-497c-48b5-8d56-eaa4e1d71331`。HQ の Concordia が登録済み拠点の Excubitor に、本人同席で公開コードと非機密データの一般版 Colab ジョブを依頼する。GROMAC の Excubitor が専用ランタイムを割り当て、実行・回収・解放を担当する。

## 実行と解放

- `ownerStart: true` と登録された `ownerId` を必須とする。HQ は認証済み本人の明示操作を記録し、その操作に対応する依頼だけを送る。サイトは自身の有効化設定、OS アカウント、CLI の接続確認、登録プログラム、revision、SHA-256、GPU を照合する。
- SQLite は副作用の前に依頼の指紋、サイトのジョブ ID、期限を記録する。同じキーと指紋の再送は同じ receipt を返す。未解放のジョブは、同時実行枠を一つ保持する。登録済みファイルのバイト列を検証し、実行用コピーを専用ディレクトリに置く。
- サイトの期限は HQ 指定の UTC ミリ秒とサイト上限から短い方を採用する。期限または停止要求でローカルの CLI プロセスを終了し、専用名で停止して、認証済みランタイム一覧で割当 endpoint の不在を確認する。HQ との接続から独立して動作する。Excubitor 再起動後は、台帳に残ったジョブの照合と解放を再開する。
- CLI の `new` は割当応答の後でローカル名を保存する。応答が失われて割当 endpoint を特定できない場合は `release_unknown` とし、名前を照合できるまで同時実行枠を保持する。この場合は Mac の所有者が Colab のランタイム管理画面で該当候補を確認し、必要なら解放する。公式 CLI の一覧からジョブに結び付かないリソースの帰属や解放は証明できない。このケースでは Mac による期限内解放を保証できない。[CLI 0.8.0 のセッション実装](https://github.com/googlecolab/google-colab-cli/blob/v0.8.0/src/colab_cli/commands/session.py)
- Receipt の `events` に時刻付きの状態遷移を返す。実行結果とリソース解放はそれぞれ `outcome` と `phase` で確認できる。CLI の履歴・stdout・stderr は拠点内に留め、API は実行コード、ファイルパス、provider の endpoint、資格情報を返さない。

## CLI と回収

対応版は公式配布の `google-colab-cli==0.8.0`。子プロセスには必要な OS 環境変数だけを渡し、stdin を閉じる。`--auth oauth2` を明示し、ジョブ単位の `--config` は CLI に管理させる。[公式 README 0.8.0](https://github.com/googlecolab/google-colab-cli/blob/v0.8.0/README.md) · [PyPI 配布](https://pypi.org/project/google-colab-cli/0.8.0/)

| CLI コマンド | 用途 |
| --- | --- |
| `usage` | 認証済みのアカウント照会の成否を拠点 readiness に使う |
| `new -s NAME --gpu GPU` | 専用名で 1 回だけ GPU を割り当てる |
| `sessions` | 割当名と endpoint を照合し、停止後の不在を確認する |
| `exec -s NAME -f FILE --env CC_CLOUD_INPUT=JSON --timeout 0` | コピーした Python / notebook を実行する。アイドル期限は無効にし、サイトの実行期限で管理する |
| `download -s NAME content/NAME LOCAL` | 判定報告と登録済み成果物を専用ディレクトリに保存する |
| `stop -s NAME` | 専用ランタイムを解放する |

`exec` の追加フラグは [公式 0.8.0 の実装](https://github.com/googlecolab/google-colab-cli/blob/v0.8.0/src/colab_cli/commands/execution.py) を参照。CLI は OS のキーチェーンでログインを管理する。Excubitor が読み取る CLI 設定は自動更新の無効化を照合する `settings.json` に限る。[OAuth 実装](https://github.com/googlecolab/google-colab-cli/blob/v0.8.0/src/colab_cli/auth.py) · [自動更新の設定](https://github.com/googlecolab/google-colab-cli/blob/v0.8.0/src/colab_cli/auto_update.py)

`CC_CLOUD_INPUT` は `{ attemptId, sourceRevision, uploads: {} }` の JSON。HQ が `idempotencyKey` として送る試行 ID を `attemptId` に使う。プログラムは `/content/cc-result.json` に UTF-8 で `version: 1`、`attemptId`、`sourceRevision`、`exitCode`、`tests: { total, failed, skipped }` または `metrics` を出力する。`checkpoints` は登録済み出力ごとの `{ name, bytes, sha256 }`。名前はファイル名だけを許容する。上限は報告 128 KiB、成果物 16 MiB × 最大 8 件。サイトは出力の名前・サイズ・ダイジェストを照合してから manifest を公開する。公式 CLI はダウンロードを内部でバッファするため、サイトでのファイル上限は CLI の書き込み後に検査する。大型チェックポイントは既存の Drive 返送経路で扱う。[CLI のファイル取得実装](https://github.com/googlecolab/google-colab-cli/blob/v0.8.0/src/colab_cli/contents.py)

## HQ とサイトの API

HQ の loopback は `/api/v1/colab/peers/:site/jobs`。名前付きサイトの引数 `site` は登録ピア ID と一致させる。サイトのメッシュ専用リスナーは `/api/v1/federation/colab/jobs`。有効な登録済み HQ ピアからの Cr v1 HTTPS 署名付き要求だけを受理する。既存 Cr の許可種別を使い、資源を各操作で `service:colab-site-runner` に完全一致させる。このサービスコードはメッシュの汎用依頼 API で予約する。

| パスの続き | HTTP | Cr の action | 契約 |
| --- | --- | --- | --- |
| 空 | POST | `operation:start` | `idempotencyKey`、`ownerId`、`ownerStart: true`、`programId`、`sourceRevision`、`programSha256`、`gpu`、`deadlineAt`、`code: "public"`、`data: "non_confidential"`。初回 202、同一再送 200 |
| `/:id` | GET | `operation:reflect` | ジョブ receipt と状態遷移 |
| `/:id/cancel` | POST | `operation:stop` | 停止を記録して receipt を返す |
| `/:id/collect` | POST | `operation:data-export` | `{}` は manifest。`{"name":"..."}` は 1 ファイルのバイナリ。HQ の Ex は検証後にそのファイルを返す |

HQ が送信結果を取得できなかった場合は、同じ依頼と同じキーで receipt を取り直せる。異なるキーは新規依頼になる。サイトが回収済みならリリース後も取得できる。ジョブの状態と停止要求は、サイトの Excubitor WebUI の「Colab 拠点」から確認できる。

## GROMAC への導入手順

1. GROMAC の LaunchDaemon の `UserName` を所有者のアカウントと照合する。同じアカウントで `uv tool install google-colab-cli==0.8.0` を実行し、`command -v colab` で絶対パスを確認する。CLI の `~/.config/colab-cli/settings.json` に既存項目を保持して `"enable_update_check": false` を設定する。そのアカウントで `colab --auth oauth2 usage` を対話実行し、Google が求める同意とログインを完了する。
2. オーナー専用のモード `0700` の実ディレクトリをジョブ保存先に作る。公開可能な固定版だけを登録し、`git rev-parse HEAD` と `shasum -a 256` で revision・ファイルの SHA-256 を確認する。サイトの JSON を用意し、既存の LaunchDaemon の環境変数へ絶対パスの `EXCUBITOR_COLAB_CONFIG_FILE` を設定する。HQ 側にも同じ環境変数で `{"hq":{"sitePeerId":"<GROMAC の登録ピア ID>"}}` を設定する。
3. 既存のメッシュについて、GROMAC の登録に HTTPS の専用リスナーを指定し、GROMAC 側の `hqPeerId` を HQ のピア ID と照合する。Cr で HQ workload → GROMAC workload に対し表の四つの action と同じ資源を付与する。双方へ Excubitor を既存の配布手順で反映する。「Colab 拠点」の接続確認を、オーナーがログインしキーチェーンが利用可能な状態で行う。LaunchDaemon の実行コンテキストからキーチェーンを使えないときは投入を停止する。

拠点設定例（ID、絶対パス、digest、revision は実値で置き換える）。

```json
{
  "colab": {
    "enabled": true,
    "cliPath": "/Users/owner/.local/bin/colab",
    "jobRoot": "/Users/owner/colab-site-jobs",
    "osUser": "owner",
    "ownerId": "owner-id",
    "hqPeerId": "hq-peer-id",
    "maxRuntimeSeconds": 1800,
    "programs": {
      "train": {
        "path": "/Users/owner/registered/train.py",
        "sourceRevision": "2222222222222222222222222222222222222222",
        "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        "gpu": "T4",
        "outputs": ["checkpoint.bin"]
      }
    }
  }
}
```

## 受け入れ契約

```text
C-39 authorizeColabStart(input): 有効な拠点設定と登録済みの本人が明示開始した場合だけ起動を許す
C-40 admitColabJob(input): 同じキーの同一依頼は既存 receipt に戻し、不一致と同時投入を拒否する
C-41 releaseConfirmed(input): 割当済み endpoint の不在を認証済み一覧で確認した場合だけ解放とする
C-42 allowsColabPeer(input): 登録済み HQ の有効な Cr 許可を操作と Colab 資源に完全一致で要求する
C-43 verifyArtifactBytes(input): 上限以内でサイズと SHA-256 が一致するバイト列だけを受け入れる
```
