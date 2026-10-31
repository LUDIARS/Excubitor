---
title: Network watch
description: tshark (Wireshark) でこの PC の通信先を集め、国外への通信をマークして Tela のデスクトップオーバーレイへ一覧を渡す。
---

# Network watch (通信監視) {#SPEC-EX-NETWATCH}

SPEC-EX-NETWATCH。2026-10-31 Discord フォーラムでの依頼
「Exに通信監視を入れる。監視はWireSharkで考えてる。国外ドメインへの通信をマークし、Tela でオーバーレイする UI に
通信先とドメイン情報わかればそれを出す」による。Actio: `actio:928e7b31-c1f4-4604-9759-487745de243c`。
検知の強化 (送信元プロセス・サービスの除外・怪しい通信の判定) は同日の依頼「outbound の怪しい通信を止めたい →
対象はサービス以外の PC の全通信 → 検知の強化だけ」による。Actio: `actio:a8be3f9b-a9d4-45c1-849d-fdfee20a0aab`。
検知は通信を止めない。遮断は同日の依頼「ルーターと WFW の Endpoint → 先に WFW だけ」による別の仕組みで、
**人が API で登録したものだけ** を Windows ファイアウォールで止める (下の「遮断」)。Actio: `actio:803a1456-5df0-463f-b396-c130a19a644c`。
ルーターでの遮断は機種が決まってから。

## 目的

この PC がどこと通信しているかを、宛先 IP・ドメイン・国つきで常に見えるようにする。特に国外への通信は
印をつけて目立たせる。ブラウザで Excubitor を開かなくても、デスクトップの隅で見られるようにする (Tela)。

## 構成

```
tshark (Wireshark CLI, 子プロセス)
  └ 1 パケット 1 行 (タブ区切りのフィールドだけ。ペイロードは出させない)
      → tshark-line.ts      行 → 観測 (DNS 応答 / TLS・QUIC の SNI / HTTP Host / TCP SYN)
      → observation-ingest  DNS 応答を「アドレス → 名前」として覚え、通信先にドメインを付ける
      → destination-store   通信先 (アドレス単位) の集計と国外判定
      → owner-attribution   自分側ポートを接続表 (netstat -ano) と突き合わせて送信元プロセスを付ける
  suspicion.ts (読み出し時) サービスの通信か・怪しいかを判定
          ├ /api/v1/netwatch/status, /api/v1/netwatch/destinations
          └ data/netwatch/overlay.telalist (TELA_LIST_VIEW 1) → Tela のデスクトップオーバーレイ
```

| ファイル | 責務 |
|---|---|
| `src/netwatch/tshark-command.ts` | tshark の引数 (フィールド・キャプチャフィルタ・表示フィルタ・名前解決フラグ) |
| `src/netwatch/tshark-line.ts` | 1 行を観測にする |
| `src/netwatch/tshark-process.ts` | tshark 1 本の寿命 (stdout は行、stderr は末尾だけ控える) |
| `src/netwatch/capture-supervisor.ts` | 起動・停止・異常終了後の待機・定期的な起動し直しと状態 |
| `src/netwatch/settings.ts` | config と拠点の env から、この拠点で動かす設定を決める |
| `src/netwatch/address-scope.ts` | 宛先の範囲 (public / private / loopback / link-local / multicast) |
| `src/netwatch/locality.ts` | 国コードの正規化と国外判定 |
| `src/netwatch/dns-answer-cache.ts` | キャプチャした DNS 応答の「アドレス → 名前」 |
| `src/netwatch/destination-store.ts` | 通信先の集計 |
| `src/netwatch/observation-ingest.ts` | 観測を集計へ反映する |
| `src/netwatch/tela-list-format.ts` | `TELA_LIST_VIEW 1` の書き出し (通信監視を知らない) |
| `src/netwatch/netwatch-list-view.ts` | 通信先の集計を一覧の行に変える |
| `src/netwatch/atomic-text-file.ts` | 一時ファイル + rename で置き換える |
| `src/netwatch/connection-table.ts` | `netstat -ano` の解析と「自分側ポート → PID」 |
| `src/netwatch/connection-poller.ts` | 接続表の周期読み取りと状態 |
| `src/netwatch/owner-resolver.ts` | PID → 実行ファイル名とサービス (親をたどる) |
| `src/netwatch/owner-attribution.ts` | 観測と接続表の突き合わせ (表に現れるまで待たせる) |
| `src/netwatch/suspicion.ts` | サービスの通信か・怪しいかの判定 |
| `src/netwatch/cidr.ts` | IP / CIDR を範囲として扱う (重なりの判定) |
| `src/netwatch/block-target.ts` | 遮断の対象の検証・正規化と守る範囲・守るプログラム |
| `src/netwatch/block-registry.ts` | 遮断の希望状態 (ファイルの形・期限) |
| `src/netwatch/block-settings.ts` | `netwatch.block` と拠点の環境から遮断の設定を決める |
| `src/netwatch/block-service.ts` | 登録・解除・期限切れ (1 件ずつ書き、失敗は巻き戻す) と反映状況 |
| `src/netwatch/firewall-sync-status.ts` | 同期タスクの状態ファイルの読み取り |
| `src/netwatch/block-runtime.ts` | 遮断の組み立てと周期処理 (設定・期限・状態ファイル) |
| `src/netwatch/block-router.ts` | 遮断 API |
| `scripts/netwatch-firewall-sync.ps1` | 同期タスク本体 (SYSTEM、希望状態 → ファイアウォール) |
| `scripts/install-netwatch-firewall.ps1` / `uninstall-netwatch-firewall.ps1` | 同期タスクの導入・解除 (管理者で実行) |
| `src/netwatch/runtime.ts` | 組み立てとタイマー (設定の確認・接続表の読み取り・一覧の書き出し) |
| `src/netwatch/router.ts` | 読み出し API |

## 契約

### 有効化 (拠点ごと)

- `excubitor.config.yaml` は全拠点で共有するため、方針 (`netwatch:`) だけを置く。
- キャプチャするのは env **`EXCUBITOR_NETWATCH_INTERFACE`** を設定した拠点だけ。値は `tshark -D` の名前か番号。
  未設定なら tshark を起動せず、状態は `disabled`、理由は `EXCUBITOR_NETWATCH_INTERFACE 未設定`。
- tshark の場所は env **`EXCUBITOR_NETWATCH_TSHARK`** (任意)。未設定なら PATH 上の `tshark`。
  見つからなければ `backoff` と理由 (`tshark を起動できない: spawn tshark ENOENT`) を出し、
  `C:\Program Files\Wireshark` など別の場所を探しに行かない。
- `netwatch.enabled: false` は全拠点の停止スイッチ (env があっても動かさない)。
- env は Excubitor の起動時の環境から読むので、設定・変更したら Excubitor の再起動が要る。

### キャプチャ

- tshark は shell を介さず引数配列で起動し、`-l` (行ごとに flush)・`-T fields`・タブ区切り・`occurrence=a`
  (複数値はカンマ区切り) で、決めたフィールドだけを出させる。ペイロードは出させず、保存もしない。
- 既定のキャプチャフィルタ (BPF) で、TCP の接続開始 (SYN のみ)・DNS (53)・443 の TLS ハンドシェイク
  (ClientHello)・QUIC のロングヘッダ・HTTP (宛先 80) だけをカーネル側で通す。動画などの大きな通信は tshark に届かない。
  `netwatch.capture_filter` で差し替えられる。
- 表示フィルタで、SYN だけのパケット・ClientHello・HTTP 要求・DNS 応答の行だけを出す。
- 対象は **この PC が始めた通信** (宛先が相手)。DNS 応答だけは送信元 (DNS サーバ) を相手にする。
  外から受けた接続の SYN は、相手ではなくこの PC のアドレスが宛先として載る (下の「未確認」)。
- tshark は長時間動かすと内部状態が積み上がるため、`restart_after_min` (既定 60 分) ごとに止めてから起動し直す。
  2 本同時に動かすと同じパケットを二重に数えるので、重ねない (止めた後、次の確認で起動)。
- 異常終了・起動失敗は stderr の最終行を理由にして `backoff` とし、`retry_after_sec` (既定 30 秒) 後に起動し直す。
- 設定 (tshark・引数) が変わったら止めて、終了を受けてから新しい設定で起動する。確認は 5 秒ごと。

### 名前解決とドメイン

- tshark の `-N` には `netwatch.name_resolution` (既定 `g`) を渡す。`g` は Wireshark の MaxMind GeoIP。
  **`n` / `N` (外部 DNS) は設定エラー**として拒否する。tshark 自身が DNS を引くと、その問い合わせが通信になるため。
  空なら `-n` で名前解決をすべて切る (国が付かなくなる)。
- ドメインは、SNI (TLS / QUIC) と HTTP Host を最優先にし、無ければ **キャプチャした DNS 応答** で覚えた名前を付ける。
  Excubitor 自身は DNS を引かない。DNS 応答の名前は `dns_ttl_sec` (既定 1 時間) まで使い、1 アドレス 5 件まで覚える。
  名前は小文字・末尾ドット除去で揃え、名前として不正な値は捨てる。

### 国外判定

- 国は Wireshark の MaxMind 解決 (`ip.geoip.*_country_iso` / `ipv6.geoip.*_country_iso`) が付けた値だけを使う。
  ドメインの TLD などからは推測しない (`.com` は国を表さず、推測で国内と出すと見落とすため)。
- 範囲が public 以外 (private・CGNAT/Tailscale の 100.64.0.0/10・loopback・link-local・multicast) は `local`。
- public で国が `home_country` (既定 `JP`) と違えば `foreign`、同じなら `domestic`、国が付かなければ `unknown`。
  `unknown` を国外とも国内とも扱わない。
- 一度付いた国は、国の付かない後の観測で消さない。
- 公開アドレス宛ての観測で国が 1 件も付かないときは、GeoIP の未設定を疑う一言を状態に出す
  (`public_without_country` が `public_observed` と同じ)。

### 集計

- 通信先はアドレス単位。ドメイン (新しい順に 8 件)・ポート (8 件)・観測の種類・初回と最終の時刻・回数を持つ。
- `max_destinations` (既定 5000) を超えたら、最後に見た時刻が古いものから捨てる。DNS の対応表はその 4 倍まで。
  どちらの上限も、キャプチャの設定が初めて読めたときの値で作るので、変えたら Excubitor の再起動が要る。
- 集計はメモリだけに持ち、DB には書かない (再起動で消える)。
- 通信監視の設定が読めなくても Excubitor の起動は止めない。起動時には設定を読まず、5 秒ごとの確認で
  読めなければ通信監視だけを `failed` (理由 `設定が不正: ...`) にする。監視のタイマーは Node の終了を妨げない (unref)。

### 送信元プロセス (Windows)

- tshark はプロセスを知らないので、観測の自分側ポート (TCP は `tcp.srcport`、UDP は `udp.srcport`、DNS 応答は
  `udp.dstport`) を OS の接続表と突き合わせる。接続表は `netstat -ano` を `detect.owner_poll_sec` (既定 2 秒) ごとに
  1 回ずつ読む (前の回が終わるまで次を始めない)。見出し・状態名は OS の言語で変わるので、列の数と形だけで読む。
- TCP は自分側ポートと相手アドレスが一致する行、無ければそのポートの持ち主が 1 つに決まるときだけ採る。UDP はポートで引き、
  持ち主が複数なら採らない。PID 0 (TIME_WAIT など) は捨てる。**決まらないものは不明のまま** (推測しない)。
- 観測の時点の表に無い接続は、次の表まで待たせる (周期の 3 回分、最大 2000 件)。期限までに現れなければ不明のまま捨てて
  `expired` に数える。すぐ閉じる接続は表に載らないことがある。
- 実行ファイル名は process-snapshot (60 秒ごとの全プロセス走査) から引く。走査より新しいプロセスは名前が付かず `pid N` と出る。
- **サービスの通信**: Excubitor が起動・採用したサービスの根 pid (DB の running instance) と Excubitor 自身の pid を根に、
  親 pid をたどって行き着けばそのサービス。1 宛先に付くプロセスは新しい順に 4 件。
- Windows 以外では特定しない (状態 `unsupported`)。`owner_poll_sec: 0` で止める。キャプチャしていない間は読まない。
- 表を読めなければ状態を `failed` と理由にし、別のコマンドを試しに行かない。

### 怪しい通信の判定

- 判定するのは public の宛先で、**通信したプロセスがすべてサービスではないもの** (1 つでもサービス以外か、不明が混ざれば判定する)。
- **国外であることは理由にしない** (開発で使う通信の大半は国外のため)。国外は従来どおり印 (`alert`) だけ付ける。
- 理由:
  - `direct-ip` (`IP直接`): DNS 応答・SNI・Host のどれでも名前が付かない = アドレスを直に指定してつないだ。
  - `unusual-port` (`許可外ポート`): 宛先ポートが `detect.allowed_ports` (既定 53 / 80 / 443 / 853) に無い。
- 判定しないもの: DNS 応答だけで知った宛先 (DNS サーバ)、`detect.trusted_domains` のドメインとその配下が付いた宛先。
- 判定は読み出し時に行い、集計には残さない (設定を変えれば次の読み出しから効く)。

### API (loopback の本体 17332)

- `GET /api/v1/netwatch/status`: `state` (`disabled` / `starting` / `running` / `backoff` / `failed`)・`reason`・`pid`・
  `started_at`・`stderr_tail`・`home_country`・`public_observed`・`public_without_country`・`unparsed_lines`・
  `destinations` (`foreign` / `domestic` / `unknown` / `local` の件数)・`suspicious` (怪しい件数)・
  `service_destinations` (サービスの通信の件数)・`attribution` (`state` `off` / `running` / `failed` / `unsupported`・
  `reason`・`last_refresh_at`・`attributed`・`expired`・`pending`)。
- `GET /api/v1/netwatch/destinations?locality=&limit=&suspicious=&include_services=`: 最後に見た時刻の新しい順。
  `locality` は上の 4 つ、`limit` は 1〜5000 (既定 200)。**既定でサービスの通信を外す** (`include_services=true` で含める)。
  `suspicious=true` で怪しいものだけ。各通信先に `owners` (`pid`・`name`・`service`)・`services`・`suspicious_reasons`。
  不正な値は 400。
- どちらもメモリ上の値を返すだけで、要求のたびにキャプチャ・名前解決・ファイル走査をしない。

### Tela への一覧 (`TELA_LIST_VIEW 1`)

`netwatch.overlay.file` (既定 `data/netwatch/overlay.telalist`、相対パスは Excubitor の cwd から) へ
`overlay.interval_sec` (既定 2 秒) ごとに書く。内容が変わらなければ書かない。一時ファイルへ書いてから rename するので、
読む側が書きかけを読むことはない。空にすると書かない。

- 書くのはキャプチャする拠点 (`EXCUBITOR_NETWATCH_INTERFACE` を設定した拠点) だけ。使わない拠点やテストでは
  ファイルを作らない (Tela 側は「ファイル待ち」と出る)。
- キャプチャを止めるとき (`enabled: false`・設定が不正・Excubitor の停止) は、止まった状態
  (`capture disabled: ...` / `capture failed: ...`) を一度書いてから書き出しをやめる。最後の「動作中」の一覧を残すと、
  Tela が古い通信先を今のものとして出し続けるため。書き込み中に止めたときは、この最後の一回が抜けることがある。

```
TELA_LIST_VIEW 1
title\tExcubitor 通信先
status\t怪しい 1 件 / 国外 2 件 (サービス 3 件を除外)
row\talert\tIP直接\tDE\tpid 7712\t(ドメイン不明)\t198.51.100.77:443\t10:42:10
row\talert\t国外\tUS\tchrome.exe +1\tapi.example.com\t203.0.113.5:443\t10:42:03
row\tmuted\t-\t??\t?\t(ドメイン不明)\t192.0.2.9:443\t10:41:58
row\tnormal\t-\tJP\tmsedge.exe\tjp.example\t198.51.100.1:443\t10:41:40
```

- UTF-8・BOM なし・改行 LF。1 行目は `TELA_LIST_VIEW 1`。続けて `title`・`status` を 1 行ずつ、その後に `row` を 0〜256 行。
- `row` の 2 列目は印 (`alert` / `normal` / `muted`)、3 列目以降が表示する列。値のタブ・改行・制御文字は空白にし、
  1 値は 4096 バイトまで (超えたら切って `...`)。
- 通信監視での列は「判定 (怪しい理由を `/` 区切り、国外なら `国外`、それ以外は `-`)・国 (不明は `??`)・
  プログラム (名前、無ければ `pid N`、不明は `?`、複数なら `+N`)・ドメイン (不明は `(ドメイン不明)`)・
  宛先:ポート (IPv6 は `[...]`)・最後に見た時刻」。
- **サービスの通信は出さない**。怪しいもの → 国外 → その他の順に、それぞれ最後に見た時刻の新しい順。怪しいものと国外が
  `alert`、国不明が `muted`、国内が `normal`。`overlay.include: public` (既定) はその他も出し、`foreign` は怪しいものと国外だけ。
  行数は `overlay.max_rows` (既定 12)。
- 状態行は、動いていれば `怪しい N 件 / 国外 M 件 (サービス K 件を除外)` (国外は怪しいものを含めた数)。送信元を
  特定できないとき (`failed` / `unsupported`) は `/ 送信元不明 (理由)` を足す。止まっていれば `capture <state>: <理由>`。
- 形式は Tela 側では「印つきの行の一覧」として扱い、通信監視の名前や意味に依存させない。
  Tela 側の読み込み・表示 (デスクトップオーバーレイ) は Tela の作業として別に進める。

## 遮断 (Windows ファイアウォール)

検知とは別の仕組み。**自動では止めない**。人が API で登録した対象だけを、期限付きで外向きに止める。

```
POST /api/v1/netwatch/blocks (人)
  → Excubitor: 検証 → data/netwatch/firewall-blocks.json (希望状態) を原子的に書く
      → 同期タスク (SYSTEM・1 分ごと): もう一度検証 → グループ Excubitor-netwatch のルールだけを合わせる
          → %ProgramData%\Excubitor\netwatch-firewall\status.json (反映結果)
  ← Excubitor: 状態ファイルを 15 秒ごとに読み、一覧に反映状況を付ける
```

### 権限の分け方

- Excubitor は Limited 権限で動くのでファイアウォールを変えられない。変えるのは管理者が 1 回だけ導入する同期タスク
  (`scripts/install-netwatch-firewall.ps1` を管理者の PowerShell で実行)。
- 同期タスクは SYSTEM で動く。**リポジトリ内のスクリプトは実行しない** (Limited のアカウントが書き換えられ、
  SYSTEM で任意のコードが動くため)。導入時に `%ProgramData%\Excubitor\netwatch-firewall\` (SYSTEM と Administrators だけが
  書け、Users は読むだけ・継承なし) へ写し、その写しを動かす。リポジトリを更新したら導入をやり直す。
- 状態ファイルも同じ保護されたディレクトリに書く (Limited のアカウントが書ける場所へ SYSTEM が書くと、
  リンクの差し替えで任意のファイルを上書きされるため)。Excubitor はそこを読むだけ。
- 同期タスクが読む希望状態ファイルは Limited のアカウントが書ける。そのため同期タスクは中身を信用せず、
  すべてもう一度検証する。リンク (reparse point) なら読まない。1 MiB を超えたら読まない。値はコマンド文字列に埋め込まず、
  コマンドレットの引数で渡す。読めないときは既存のルールを変えずに、状態ファイルへエラーを書く。
  JSON の中身を状態ファイルへ写さない。
- 作るのは **外向き・Block** のルールだけで、名前は `ExcubitorNetwatch-<id>`、グループは `Excubitor-netwatch`。
  許可 (Allow) のルールは作らない。このグループ以外のルールには触らない。

### 対象と守るもの

- 対象は 2 種類。
  - `address`: IPv4 / IPv6 のアドレスか CIDR。範囲の途中を指す表記は先頭に揃える。IPv4 は /8、IPv6 は /32 より広い範囲は拒否。
  - `program`: ドライブ文字から始まる `.exe` の絶対パス。UNC・相対・ワイルドカード・環境変数・`..` は拒否。
- 常に守る範囲 (重なれば拒否): `0.0.0.0/8`・`10.0.0.0/8`・`100.64.0.0/10` (Tailscale)・`127.0.0.0/8`・`169.254.0.0/16`・
  `172.16.0.0/12`・`192.168.0.0/16`・`224.0.0.0/4`・`255.255.255.255`・`::`・`::1`・`fc00::/7`・`fe80::/10`・`ff00::/8`・
  `::ffff:0:0/96`。`netwatch.block.protected_addresses` で足せる (DNS サーバなど)。
- 常に守るプログラム: `svchost.exe`・`lsass.exe`・`services.exe`・`wininit.exe`・`csrss.exe`・`smss.exe`・`system`・
  `tailscale.exe`・`tailscaled.exe`・`tailscale-ipn.exe`。`netwatch.block.protected_programs` で足せる。
  Excubitor 自身の node.exe も止めない。
- 常に守るものは、Excubitor と同期タスクの両方に同じ一覧を持つ (`block-target.ts` と `netwatch-firewall-sync.ps1`)。
  config で足した分は Excubitor 側だけで効く。

### 希望状態と期限

- `netwatch.block.file` (既定 `data/netwatch/firewall-blocks.json`):
  `{ format: "excubitor-netwatch-blocks", version: 1, blocks: [{ id, kind, value, reason, created_by, created_at, expires_at }] }`。
- 期限は `ttl_minutes` (既定 `default_ttl_min` 60 分、上限 `max_ttl_min` 7 日)。期限が来たものは Excubitor が 30 秒ごとに外して
  書き直す。同期タスクも期限切れを反映しない (時計で二重に見る)。
- 件数は `max_entries` (既定 256) まで。同じ対象が期限内にあれば 409 で既存を返す (期限は延ばさない)。
- 変更は 1 件ずつ書き、書けなければ巻き戻して 503。起動直後は、ファイルを読み終えるまで変更を受けない
  (空の状態で上書きして遮断を消さないため)。ファイルが壊れていれば変更を受けず (`state: failed`)、上書きしない。
- Windows 以外、`netwatch.block.enabled: false`、ProgramData の無い環境では API は 503 (`state: disabled` と理由)。

### API

- `GET /api/v1/netwatch/blocks`: `state` (`ok` / `disabled` / `failed`)・`reason`・`sync`
  (`state` `ok` / `missing` (未導入) / `stale` (3 分以上更新なし) / `error`・`reason`・`synced_at`)・`blocks`
  (各 `id`・`kind`・`value`・`reason`・`created_by`・`created_at`・`expires_at`・`enforcement` (`applied` / `pending` / `rejected`)・
  `enforcement_reason`)。値は周期で読んだメモリ上のもの。
- `POST /api/v1/netwatch/blocks`: `{ kind, value, reason (1〜200 文字), ttl_minutes? }`。知らない項目は 400。
  登録者は `x-excubitor-actor`。201 で登録した遮断を返す。反映は次の同期 (最大 1 分) で、それまでは `pending`。
- `DELETE /api/v1/netwatch/blocks/:id`: 解除。ルールは次の同期で消える。
- 他の `/api/*` と同じく `localBrowserGuard` の内側 (loopback と許可した origin だけ)。

### 導入と解除 (管理者)

- 導入: `scripts/install-netwatch-firewall.ps1 [-BlocksFile <path>] [-IntervalMinutes 1]`。既定の希望状態ファイルは
  そのチェックアウトの `data\netwatch\firewall-blocks.json`。タスクは起動しない (次の周期で動く)。
- 解除: `scripts/uninstall-netwatch-firewall.ps1 [-RemoveFiles]`。タスクとグループ内のルールをすべて消す (= Excubitor 経由の
  遮断はすべて止まる)。

## 前提 (拠点で用意するもの)

- Wireshark (tshark) と、Windows ではキャプチャドライバ Npcap。Excubitor は Limited 権限の Scheduled Task で動くので、
  Npcap は「管理者だけにキャプチャを許す」を外して入れる (外さないと tshark が権限エラーで終わり、`backoff` に理由が出る)。
- 国を付けるには、Wireshark の設定 (名前解決 → MaxMind database directories) に GeoLite2-Country などの
  `.mmdb` を置いたディレクトリを登録する。Excubitor を動かすアカウントの Wireshark 個人設定で登録する。
  DB は同梱しない (ライセンス)。

## 検証

- 単体テスト: `src/netwatch/*.test.ts` (行の解析と引数、範囲・国外判定・DNS 対応表・集計・観測の反映、一覧の形式、
  起動・停止・待機・起動し直し、設定の決め方、API、接続表の解析、送信元の突き合わせとサービス判定、怪しい通信の判定)。
  遮断は `block-target.test.ts`・`block-service.test.ts`・`block-router.test.ts`・`block-settings.test.ts`。
- 2026-10-31 時点で、この変更は型検査だけを行った。テストの実行・実機キャプチャはしていない (検知の強化も同じ)。
  同期スクリプト 3 本は PowerShell の構文解析だけを通した (実行・導入はしていない)。

## 未確認

- 実機での tshark の起動・キャプチャ (Npcap の権限、インタフェース名)。この作業をした PC には Wireshark が入っていない。
- `-N g` で MaxMind の国が付くこと (Wireshark の版ごとの名前解決フラグ、Scheduled Task のアカウントでの個人設定)。
- 既定キャプチャフィルタの ClientHello 判定 (TCP オプション長の計算) と QUIC ロングヘッダの判定が、実際の通信で取りこぼさないこと。
- 外から受けた接続 (この PC がサーバ側) の扱い。今はこの PC のアドレスが「通信先」として載る (多くは private なので `local`)。
- 送信元プロセスの突き合わせの取りこぼし率 (2 秒周期の netstat に載らない短い接続)。多ければ ETW (Microsoft-Windows-TCPIP) への置き換えを検討する。
- netstat -ano を 2 秒ごとに起動する負荷 (接続の多い PC での所要時間)。
- 怪しい判定の誤検知の量 (`allowed_ports`・`trusted_domains` の初期値が実際の通信に合うか)。
- 長時間の負荷 (tshark のメモリ、行数)。
- 同期タスクの実機での動き: SYSTEM での New-NetFirewallRule / Remove-NetFirewallRule、`-Once -RepetitionInterval` の
  繰り返しが無期限で続くこと、保護ディレクトリの ACL、状態ファイルの書き込み。導入もしていない。
- ドメイン単位の遮断は無い (IP / CIDR とプログラムだけ)。CDN の共有アドレスを止めると無関係なサイトも止まる。
