param(
  [string]$Name = "Excubitor",
  [switch]$TaskFallback
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Push-Location $Root
try {
  npm install
  npm run build
  npm --prefix frontend install
  npm --prefix frontend run build
} finally {
  Pop-Location
}

$Nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if ($Nssm -and -not $TaskFallback) {
  & $Nssm.Source install $Name "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$Root\scripts\run-service.ps1`""
  & $Nssm.Source set $Name AppDirectory $Root
  & $Nssm.Source set $Name AppEnvironmentExtra "EXCUBITOR_SERVICE_MODE=1" "EXCUBITOR_SAFE_MODE=0"
  & $Nssm.Source set $Name AppStdout "$LogDir\service.out.log"
  & $Nssm.Source set $Name AppStderr "$LogDir\service.err.log"
  & $Nssm.Source set $Name Start SERVICE_AUTO_START
  & $Nssm.Source start $Name
  Write-Host "Installed Windows service '$Name' with nssm."
  exit 0
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$Root\scripts\run-service.ps1`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $Name
Write-Host "nssm was not found. Installed hidden startup task '$Name' instead."
