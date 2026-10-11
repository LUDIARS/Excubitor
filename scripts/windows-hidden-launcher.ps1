# Builds the windowless supervisor launcher (windows-hidden-launcher.cs).
# Dot-sourced by install-service.ps1 and set-service-headless.ps1. Design: spec/plan/design.md section 17.7.
#
# The output name carries the source hash, so a running task's exe is never overwritten and an
# unchanged source is not rebuilt. The source is UTF-8 without BOM: never read it with the
# Windows PowerShell 5.1 default (ANSI) encoding, or the comments corrupt the code.

function Install-ExcubitorHiddenLauncher([string]$DataDir) {
  $Source = Join-Path $PSScriptRoot 'windows-hidden-launcher.cs'
  $Hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $Output = [IO.Path]::GetFullPath((Join-Path $DataDir "excubitor-hidden-launcher-$Hash.exe"))
  if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) {
    $Temporary = "$Output.tmp-$PID.exe"
    Add-Type -TypeDefinition (Get-Content -LiteralPath $Source -Raw -Encoding UTF8) -OutputAssembly $Temporary -OutputType WindowsApplication
    Move-Item -LiteralPath $Temporary -Destination $Output -Force
  }
  return $Output
}

function Test-ExcubitorHiddenLauncherPath([string]$Path) {
  return [IO.Path]::GetFileName([string]$Path) -like 'excubitor-hidden-launcher-*.exe'
}
