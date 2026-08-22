<#
.SYNOPSIS
  Rancher Desktop の provisioning ディレクトリへ 10-dockerd-tcp.start を配置し、
  dockerd を tcp://127.0.0.1:2375 で公開できるようにする (Excubitor の wsl-helper 迂回用)。
.NOTES
  反映には Rancher Desktop の再起動が要る。 配置後:
    1. Rancher Desktop を再起動
    2. curl http://127.0.0.1:2375/_ping が OK を返すことを確認
    3. excubitor.config.yaml に docker.host: tcp://127.0.0.1:2375 を書いて Excubitor を再起動
  ログに "docker engine endpoint ... tcp://127.0.0.1:2375" が出れば wsl-helper 非経由。
#>
param(
  [string]$ProvisioningDir = (Join-Path $env:LOCALAPPDATA 'rancher-desktop\provisioning'),
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'rancher-provisioning\10-dockerd-tcp.start'
$dst = Join-Path $ProvisioningDir '10-dockerd-tcp.start'
if ($Remove) {
  if (Test-Path $dst) { Remove-Item $dst; Write-Host "removed $dst" } else { Write-Host "not installed: $dst" }
  Write-Host 'Rancher Desktop を再起動すると /etc/conf.d/docker の追記行は残るが無害 (次回 start で上書き)。'
  exit 0
}
if (-not (Test-Path $ProvisioningDir)) { throw "provisioning dir not found: $ProvisioningDir (Rancher Desktop 未インストール?)" }
# WSL 側で実行されるため LF 固定で書く
$content = (Get-Content -Raw -Encoding UTF8 $src) -replace "`r`n", "`n"
[IO.File]::WriteAllText($dst, $content, (New-Object Text.UTF8Encoding($false)))
Write-Host "installed $dst"
Write-Host 'Rancher Desktop を再起動してから: curl http://127.0.0.1:2375/_ping'
