[CmdletBinding()]
param()

# Runs the Ergo package update delivery job once (spec/feature/ergo-watch-delivery.md).
# Webhooks are read from Excubitor's encrypted config; never pass them as arguments or log them.

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cliPath = Join-Path $repoRoot 'dist\update\ergo-watch\cli.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Ergo watch CLI is not built: $cliPath. Run npm run build first."
}
$node = Get-Command node -ErrorAction Stop
$logDirectory = Join-Path $repoRoot 'logs\ergo-watch'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory ("{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

Push-Location $repoRoot
try {
  $output = & $node.Source $cliPath '--deliver' '--json' 2>&1
  $exitCode = $LASTEXITCODE
  $output | Out-File -LiteralPath $logPath -Encoding utf8 -Append
  $output
  exit $exitCode
} finally {
  Pop-Location
}
