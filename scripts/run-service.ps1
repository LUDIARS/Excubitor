param(
  [string]$Name = "Excubitor"
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$env:EXCUBITOR_SERVICE_MODE = '1'
$env:EXCUBITOR_SAFE_MODE = '0'
$env:EXCUBITOR_SERVICE_NAME = $Name
npm run service
