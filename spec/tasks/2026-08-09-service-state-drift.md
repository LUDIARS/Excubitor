---
task: service-state-drift
project: Excubitor
kind: 実装
created: 2026-08-09
memory_links:
  - project-excubitor-local-control-plane
---

# サービス state / PID の報告が実体とズレる

## 目的

2026-08-09、Cc の不調を調査中に Excubitor の報告が実体と食い違うことが判明した。
同時刻の実測との突合:

| 対象 | Excubitor の報告 | 実体 (`Get-NetTCPConnection` / `Win32_Process`) |
|---|---|---|
| concordia (11111) | pid **24748** | pid **32256**。24748 は**既に存在しない** |
| genius (4230) | `state: "stopped"`, `conflict: true` | pid 69548 が listening 中 |
| revisor (4240) | `state: "stopped"`, `conflict: true` | pid 18132 が listening 中 |

`listening: true` と `state: "stopped"` が同時に立ち、`conflict: true` が付く。
つまり「catalog 上は停止しているはずのポートを誰かが掴んでいる」という表現に
なっているが、実際はそのサービス本体が正常に動いているだけである。

これは運用判断の土台を狂わせる。実際にこの調査では、Excubitor の情報と
`node dist/server.js` という区別のつかない CommandLine を合わせて読んだ結果、
**Genius と Manus のプロセスを Concordia の孤児と誤認**した (停止直前のポート確認で
気づいたため実害は無し)。

## 完了条件

- state と実 listening 状態が食い違わないこと。少なくとも、listening しているのに
  `stopped` と報告する状態を無くす。
- 報告する PID が現存プロセスであること。消えた PID をキャッシュし続けない。
- `conflict: true` の意味を仕様として明確化する。「catalog 宣言ポートを別プロセスが
  占有」なのか「自サービスが管理外で動いている」なのかを区別できる表現にする
  (現状は両者が同じ形で出る)。
- 直し方は問わないが、**state の更新契機**(ヘルスチェック / プロセス走査 / イベント)
  のどれが遅れているのかを特定した上で直すこと。表示だけ辻褄を合わせない。

## スコープ (編集可ディレクトリ)

- `src/`
- `spec/`
