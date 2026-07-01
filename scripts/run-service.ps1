$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$env:EXCUBITOR_SERVICE_MODE = '1'
$env:EXCUBITOR_SAFE_MODE = '0'
npm run service
