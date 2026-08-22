# Docker Engine API 直叩き (wsl-helper 迂回)

## 背景

Windows + Rancher Desktop では `docker` CLI は `wsl-helper.exe docker-proxy serve` が提供する
名前付きパイプ `\.\pipe\docker_engine` 経由で backend に届く。 CLI を 1 回 spawn するたびに
wsl-helper 側でハンドルが 10 個強 回収されずに残り (2026-08-22 実測: `docker ps` ×10 で +126)、
Excubitor の周期プローブ (`docker stats` 毎分 / `docker ps -a` 2 分毎) だけで +7 ハンドル/分、
数日で WSAENOBUFS (Rancher 死亡 → docker/wsl CLI 全滅) に至る。 過去の 3 経路
(docker logs -f / ハング再 spawn / wsl -l 列挙) を塞いだ後に残った最後の経路。

## 第 1 段: CLI を Engine API に置換 (本 PR)

- `src/docker/engine-endpoint.ts` — 接続先解決 (`docker.host` config → env `DOCKER_HOST` → 既定)
- `src/docker/engine-client.ts` — `http.request` (socketPath / tcp) の GET JSON クライアント。 子プロセス無し
- `src/docker/containers.ts` — `GET /containers/json?all=1` → 旧 `docker ps -a` 互換の `DockerContainer`
- `src/docker/stats.ts` — `GET /containers/{id}/stats?stream=false` → 旧 `docker stats` 互換の `DockerMemStat`
  (mem used = usage − inactive_file、 cpu% = Δcpu/Δsystem × online_cpus、 docker CLI と同式)

名前付きパイプ経由のままでも残留は 1 接続 ≒ 1 ハンドル (実測 ×30 で +35) と 1/10 になる。
`docker compose up/down` (control/docker-compose.ts) は操作時のみなので CLI のまま。

## 第 2 段: dockerd を TCP 公開して wsl-helper を完全に外す

WSL2 の localhost forwarding で Windows → distro 内 `127.0.0.1:2375` に届くため、
dockerd 自身に TCP を listen させれば wsl-helper は一切通らない。

1. `scripts/install-rancher-dockerd-tcp.ps1` を実行 → `%LOCALAPPDATA%\rancher-desktop\provisioning\10-dockerd-tcp.start` 配置
   (distro 起動時に `/etc/conf.d/docker` へ `DOCKER_OPTS="... -H tcp://127.0.0.1:2375"` を追記)
2. Rancher Desktop 再起動 → `curl http://127.0.0.1:2375/_ping` が `OK`
3. `excubitor.config.yaml`:
   ```yaml
   docker:
     host: tcp://127.0.0.1:2375
   ```
4. Excubitor 再起動。 起動ログ `docker engine endpoint` が `tcp://127.0.0.1:2375` になる

loopback のみ・認証無しなので `0.0.0.0` には絶対に bind しない。 Rancher Desktop の dockerd
起動引数が `/etc/conf.d/docker` の `DOCKER_OPTS` を読むことは Rancher 復旧後に実機で確認する
(未確認: 2026-08-22 時点で Rancher が WSAETIMEDOUT で応答せず検証できなかった)。
読まない場合の代替は `daemon.json` の `hosts` ではなく (CLI 引数の `-H` と競合する)、
provisioning script 内で `socat TCP-LISTEN:2375,bind=127.0.0.1,fork UNIX-CONNECT:/var/run/docker.sock` を起動する。

## 設定

| キー | 既定 | 意味 |
|---|---|---|
| `docker.host` (excubitor.config.yaml) | 無し | DOCKER_HOST 互換表記 (`tcp://` / `npipe://` / `unix://`) |
| env `DOCKER_HOST` | 無し | config 未設定時のフォールバック |
| プラットフォーム既定 | win32: `\.\pipe\docker_engine`、 他: `/var/run/docker.sock` | |
