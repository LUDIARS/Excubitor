---
title: DNS filter
description: Excubitor が DNS を中継し、規則に当たる名前を NXDOMAIN で止める。待ち受けと上流は拠点ごとの env。
---

# DNS filter (DNS フィルタ) {#SPEC-EX-DNS-FILTER}

SPEC-EX-DNS-FILTER。2026-10-31 Discord フォーラムでの依頼「DNSフィルターをEx側に用意」による。
直前の話題 (怪しい外向き通信の遮断 → ルーターは機種未定 → IP 直打ちをルーターで止める手段) の続きで、
ルーターではなく Excubitor 側で DNS を持つ。Actio: `actio:f7082211-f240-42bc-bfa7-12077d323f27`。

## 目的

この PC (と、ルーターが配る DNS をここへ向ければ LAN の機器) の名前解決を Excubitor に通し、
止めたいドメインを名前の段階で止める。どの名前を引いたかを Excubitor で見えるようにする。

止められるのは **名前を引いてから始まる通信だけ**。IP 直打ちの通信は名前解決を通らないので、
DNS フィルタでは止まらない。IP 直打ちの検知は通信監視 (SPEC-EX-NETWATCH の `direct-ip`)、
遮断は Windows ファイアウォールの遮断 API (`/api/v1/netwatch/blocks`) が受け持つ。

## 構成

```
クライアント (この PC / LAN) ──UDP/TCP 53──▶ listener.ts (待ち受け 1 アドレスにつき UDP + TCP)
                                              └ resolver.ts
                                                  1. 相手の範囲 (client-policy.ts)。範囲外は答えない
                                                  2. 問い合わせを読む (dns-message.ts)。読めなければ FORMERR
                                                  3. 名前を規則で判定 (domain-rules.ts)。止める名前は NXDOMAIN
                                                  4. 上流へそのまま中継 (upstream.ts)。受けた経路 (UDP/TCP) と同じ経路
                                                  5. 応答を確かめて返す。A / AAAA を netwatch の名前付けへ渡す
                                                  └ query-log.ts (直近の問い合わせと件数、メモリだけ)
runtime.ts  設定の周期確認 (5 秒)・規則ファイルの読み込み・期限切れの除去・待ち受けの開け閉め
router.ts   /api/v1/dns-filter/*
```

| ファイル | 役割 |
|---|---|
| `src/dnsfilter/dns-message.ts` | DNS メッセージの読み書き (質問 1 件の問い合わせ、RCODE だけの応答、上流応答の照合と A/AAAA の抽出) |
| `src/dnsfilter/domain-rules.ts` | ドメインの正規化、配下を含む一致、許可 → 拒否 (API → config → DoH) の判定、既知の DoH 一覧 |
| `src/dnsfilter/rule-registry.ts` | API で足す拒否規則の持ち物とファイル形式 |
| `src/dnsfilter/rule-service.ts` | 規則の登録・解除・期限切れ (1 件ずつ書き、書けなければ巻き戻す) |
| `src/dnsfilter/endpoint.ts` | 待ち受け・上流のアドレス (`ip[:port]` / `[ipv6]:port`) |
| `src/dnsfilter/client-policy.ts` | 問い合わせを受ける相手の範囲 |
| `src/dnsfilter/settings.ts` | config と env から設定を決める |
| `src/dnsfilter/upstream.ts` | 上流への中継 (UDP は問い合わせごとのソケット、TCP は 1 問い合わせ 1 接続) |
| `src/dnsfilter/query-log.ts` | 直近の問い合わせの輪と件数 |
| `src/dnsfilter/resolver.ts` | 問い合わせ 1 件の処理 |
| `src/dnsfilter/listener.ts` | UDP / TCP の待ち受け |
| `src/dnsfilter/runtime.ts` | 組み立てと周期処理 |
| `src/dnsfilter/router.ts` | API |
| `scripts/set-dns-excubitor.ps1` | PC のネットワークアダプタの DNS をここへ向ける / 戻す (管理者、人が実行) |

## 設定

config (`excubitor.config.yaml` の `dns_filter:`、全拠点共有の方針):

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | true | false で待ち受けも規則 API も止める |
| `rules_file` | `data/dnsfilter/rules.json` | API で足す拒否規則のファイル |
| `max_rules` | 1000 | API の規則の上限 |
| `max_ttl_min` | 525600 | 期限つき規則の期限の上限 (分)。期限を省いた規則は期限なし |
| `block_doh` | true | 既知の DoH / 暗号化 DNS の入口を止める (下記) |
| `blocked_domains` | [] | 常に止めるドメイン |
| `allowed_domains` | [] | 止めないドメイン (拒否のどの規則より優先) |
| `allowed_clients` | [] | 既定 (loopback・LAN・Tailscale・link-local) に足す相手の範囲 |
| `upstream_timeout_ms` | 3000 | 上流の応答を待つ時間 |
| `max_in_flight` | 256 | 同時に中継する問い合わせの上限 (超えたら SERVFAIL) |
| `query_log_size` | 1000 | メモリに置く直近の問い合わせの件数 |

拠点ごとの env (両方を設定した拠点だけが待ち受ける):

| env | 例 | 意味 |
|---|---|---|
| `EXCUBITOR_DNS_FILTER_LISTEN` | `127.0.0.1:53,[::1]:53` | 待ち受けるアドレス (カンマ区切り)。`0.0.0.0` / `::` は不可。LAN に出すときは LAN 側のアドレスを書く |
| `EXCUBITOR_DNS_FILTER_UPSTREAM` | `1.1.1.1` | 上流 (1 つ、IP で書く。ポート省略で 53) |

- 上流は 1 つだけで、別の上流や OS の DNS 設定へは逃げない。上流が答えなければ SERVFAIL を返す。
- 上流を名前で書けないのは、Excubitor がその名前を引くと自分自身を通って循環するため。
  自分の待ち受けと同じアドレスを上流にする設定も拒否する。
- 待ち受け中に設定が不正になったら、**直前の設定のまま待ち受けを続けて** `config_error` に理由を出す
  (この PC の DNS がここを向いているので、止めると名前解決が全部止まるため)。待ち受け前なら `failed`。
- 待ち受けに失敗 (ポートが使用中・権限が無い) したら `failed` と理由を出し、5 秒ごとに開き直す。

## 判定

- 規則は **そのドメインと配下すべて** に当たる (`example.com` は `a.example.com` も止める。`notexample.com` は止めない)。
  `*.example.com` と書いても同じ意味 (前の `*.` は外す)。
- 判定の順: 許可 (`allowed_domains`) → API の規則 → `blocked_domains` → 既知の DoH。最初に当たったもので決まる。
- 止めた名前には **NXDOMAIN** (質問を写し、回答は空) を返す。型 (A / AAAA / HTTPS など) を問わず止める。
- 許可の一覧に当たるドメインは API で足しても効かないので、登録時に 409 で断る。

### 既知の DoH (`block_doh`)

ブラウザや OS が自前の暗号化 DNS (DoH) へ逃げると、このフィルタを通らない。入口の名前を止めて逃げ道を減らす:

- `use-application-dns.net` — Firefox の canary。NXDOMAIN を返すと Firefox は既定の DoH を使わない
- `mask.icloud.com` / `mask-h2.icloud.com` — iCloud プライベートリレーの canary (同様に切る)
- `dns.google`, `cloudflare-dns.com`, `dns.quad9.net`, `doh.opendns.com`, `dns.adguard-dns.com`, `dns.nextdns.io`,
  `doh.cleanbrowsing.org`, `doh.mullvad.net`, `dns.controld.com`

DoH サーバを IP で直接指定されると止まらない (上の「目的」と同じ限界)。

## 安全のための決まり

- 問い合わせを受ける相手は既定で loopback・LAN (10/8・172.16/12・192.168/16・fc00::/7)・Tailscale (100.64/10)・
  link-local だけ。範囲外からの問い合わせには **答えずに捨てる** (オープンリゾルバとして反射攻撃に使われないため)。件数だけ数える。
- 上流の応答は ID と質問 (名前・型・クラス) が問い合わせと同じものだけ返す。UDP では上流のアドレス・ポート以外から
  届いたものを捨てる。問い合わせごとに新しいソケットを使い、送信元ポートを毎回変える。
- 問い合わせの中身は書き換えずに上流へ渡す (EDNS などもそのまま)。応答も上流のものをそのまま返す。
- 直近の問い合わせはメモリだけに置き、ファイルにも DB にも残さない (どの名前を引いたかは閲覧履歴に近いので、
  見える範囲を Excubitor の画面と API に限る)。API は `/api/*` の localBrowserGuard の内側 (loopback のみ)。
- TCP は同時 64 接続まで、10 秒何も来なければ閉じる。

## 規則ファイル

`data/dnsfilter/rules.json` (一時ファイル + rename で書く):

```json
{
  "format": "excubitor-dns-filter-rules",
  "version": 1,
  "rules": [
    { "id": "<uuid>", "domain": "tracker.example", "reason": "...", "created_by": "operator",
      "created_at": "2026-10-31T00:00:00.000Z", "expires_at": null }
  ]
}
```

ファイルが読めない (壊れている・大きすぎる) ときは `state: failed` にして、上書きで規則を黙って消さないよう
変更を受け付けない (直すまで 503)。その間 API の規則は効かない (config と DoH の規則は効く)。

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/dns-filter/status` | `state` (off / starting / running / failed)・`reason`・`config_error`・`listen`・`upstream`・`counters` (total / allowed / blocked / failed / refused / malformed)・`in_flight`・`rules` (api / config / doh / allowed の数) |
| GET | `/api/v1/dns-filter/queries` | 直近の問い合わせ (新しい順)。`?limit=1..1000` (既定 100)・`action=allowed\|blocked\|failed`・`name=` (部分一致) |
| GET | `/api/v1/dns-filter/rules` | API で足した規則 (`state` / `reason` 付き) |
| POST | `/api/v1/dns-filter/rules` | `{ domain, reason, ttl_minutes? }`。省略で期限なし。登録者は `x-excubitor-actor` |
| DELETE | `/api/v1/dns-filter/rules/:id` | 解除 |

## 通信監視との関係

中継して解決できた名前とアドレス (A / AAAA、CNAME の先も含む) を通信監視の「アドレス → 名前」の対応へ渡す
(`NetwatchHandle.recordDnsAnswer`)。キャプチャしていない拠点では捨てる。

## 導入

1. 拠点の env に `EXCUBITOR_DNS_FILTER_LISTEN=127.0.0.1:53,[::1]:53` と `EXCUBITOR_DNS_FILTER_UPSTREAM=<上流の IP>` を設定し、
   Excubitor を再起動する (Excubitor 経由・本体フォルダから)。
2. `GET /api/v1/dns-filter/status` が `running` になったのを確かめる。
3. 管理者の PowerShell で `scripts/set-dns-excubitor.ps1 -InterfaceAlias <アダプタ名>` を実行し、PC の DNS をここへ向ける。
   IPv4 と IPv6 の両方を向ける (片方だけだと、ルーターから来た IPv6 の DNS で抜ける)。
4. 戻すときは `-Revert` (DHCP / RA の値に戻す)。

LAN 全体に使うときは、待ち受けに LAN 側のアドレスを足し、ルーターの DHCP が配る DNS をそのアドレスにする。

**注意: Excubitor が止まっている間 (再起動中を含む)、ここを向いた機器は名前解決ができない。**
セカンダリ DNS に上流を足すと、Windows はプライマリが遅いときにセカンダリを使うので、フィルタを抜ける。
フィルタを確実に効かせるなら足さない。

## 検証

- 単体テスト: `src/dnsfilter/*.test.ts` (メッセージの読み書き・規則の判定・規則の登録と期限・設定と env・
  resolver の各分岐 (止める / 中継 / 範囲外 / 上流の失敗と偽の応答 / 不正な問い合わせ / 同時数の上限)・履歴・API)
- 型検査

## 未確認

- 実機での待ち受け: Limited 権限の Scheduled Task で 53 番を bind できること (Windows は特権ポートを持たないが、
  Hyper-V / WSL / ICS の DNS プロキシが同じアドレスを使っていないか)。LAN 側アドレスでの待ち受けに
  Windows ファイアウォールの受信許可が要ること
- `Set-DnsClientServerAddress` に IPv4 と IPv6 を混ぜて渡したときの両方の反映
- 実際のブラウザ (Chrome / Edge / Firefox) が DoH へ逃げないこと
- 長時間・多数の問い合わせでの負荷
