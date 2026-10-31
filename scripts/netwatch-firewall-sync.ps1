# @implements SPEC-EX-NETWATCH
# Excubitor netwatch: sync outbound block rules in Windows Firewall from the desired-state file.
#
# Runs as SYSTEM from a copy under %ProgramData%\Excubitor\netwatch-firewall (installed by
# install-netwatch-firewall.ps1). The blocks file is written by Excubitor (a Limited account), so every
# entry is validated again here. Only rules in the group "Excubitor-netwatch" are created or removed,
# and only outbound Block rules are created. Values are passed as cmdlet parameters, never evaluated.
# If the blocks file cannot be read, existing rules are left as they are and the error goes to the status file.
# Messages are ASCII so that Windows PowerShell 5.1 reads this file correctly without a BOM.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BlocksFile,
  [Parameter(Mandatory = $true)][string]$StatusFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$GroupName = 'Excubitor-netwatch'
$RulePrefix = 'ExcubitorNetwatch-'
$MaxBlocks = 1000
$MaxFileBytes = 1MB
$IdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# Keep in sync with src/netwatch/block-target.ts (ALWAYS_PROTECTED_RANGES / ALWAYS_PROTECTED_PROGRAMS).
$ProtectedRanges = @(
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16', '224.0.0.0/4', '255.255.255.255/32',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '::ffff:0:0/96'
)
$ProtectedPrograms = @(
  'svchost.exe', 'lsass.exe', 'services.exe', 'wininit.exe', 'csrss.exe', 'smss.exe', 'system',
  'tailscale.exe', 'tailscaled.exe', 'tailscale-ipn.exe'
)
$MinPrefix = @{ 4 = 8; 6 = 32 }

function ConvertTo-Range([string]$Text) {
  $parts = $Text.Split('/')
  if ($parts.Count -gt 2) { return $null }
  $address = $null
  if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$address)) { return $null }
  if ($parts[0].Contains('%')) { return $null }
  $family = if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { 4 } else { 6 }
  $bits = if ($family -eq 4) { 32 } else { 128 }
  $prefix = $bits
  if ($parts.Count -eq 2) {
    if ($parts[1] -notmatch '^\d{1,3}$') { return $null }
    $prefix = [int]$parts[1]
    if ($prefix -gt $bits) { return $null }
  }
  # Big-endian address bytes -> unsigned BigInteger (BigInteger takes little-endian, plus a 0 sign byte).
  $bytes = $address.GetAddressBytes()
  [array]::Reverse($bytes)
  $value = [System.Numerics.BigInteger]::new([byte[]]($bytes + [byte]0))
  $hostBits = $bits - $prefix
  $size = [System.Numerics.BigInteger]::Pow(2, $hostBits)
  $first = [System.Numerics.BigInteger]::Divide($value, $size) * $size
  return [pscustomobject]@{ Family = $family; Prefix = $prefix; First = $first; Last = $first + $size - 1 }
}

$ProtectedRangeObjects = @($ProtectedRanges | ForEach-Object { ConvertTo-Range $_ })

function Test-Overlap($A, $B) {
  return $A.Family -eq $B.Family -and $A.First -le $B.Last -and $B.First -le $A.Last
}

# Returns a reason string when the entry must not be applied, or $null when it is acceptable.
function Get-RejectReason($Block) {
  if ($Block.kind -eq 'address') {
    $range = ConvertTo-Range ([string]$Block.value)
    if ($null -eq $range) { return 'not an IP address or CIDR' }
    if ($range.Prefix -lt $MinPrefix[$range.Family]) { return 'range is too wide' }
    # @implements SPEC-EX-NETWATCH
    foreach ($protected in $ProtectedRangeObjects) {
      if (Test-Overlap $range $protected) { return 'overlaps a protected range' }
    }
    return $null
  }
  if ($Block.kind -eq 'program') {
    $path = [string]$Block.value
    if ($path.Length -gt 260 -or $path -notmatch '^[A-Za-z]:\\' -or $path -match '[*?"<>|%]' -or $path -match '[\x00-\x1f]') {
      return 'not an absolute program path'
    }
    if ($path.Split('\') -contains '..') { return 'path contains ..' }
    if (-not $path.ToLowerInvariant().EndsWith('.exe')) { return 'not an .exe' }
    if ($ProtectedPrograms -contains [IO.Path]::GetFileName($path).ToLowerInvariant()) { return 'protected program' }
    return $null
  }
  return 'unknown kind'
}

function Write-Status([string[]]$Applied, $Rejected, [string]$ErrorMessage) {
  $status = [ordered]@{
    format    = 'excubitor-netwatch-firewall-status'
    version   = 1
    # Millisecond UTC (JavaScript Date.parse reads it exactly).
    synced_at = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    applied   = @($Applied)
    rejected  = @($Rejected)
    error     = $ErrorMessage
  }
  $json = ConvertTo-Json -InputObject $status -Depth 4
  $directory = Split-Path -Parent $StatusFile
  $temporary = Join-Path $directory ('status.' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $StatusFile -Force
}

function Read-Blocks {
  if (-not (Test-Path -LiteralPath $BlocksFile -PathType Leaf)) { return @() }
  $item = Get-Item -LiteralPath $BlocksFile -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'blocks file is a link; refusing to read it' }
  if ($item.Length -gt $MaxFileBytes) { throw 'blocks file is too large' }
  $text = [IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8)
  try {
    $document = ConvertFrom-Json -InputObject $text
  } catch {
    # Do not echo the file content into the status file.
    throw 'blocks file is not valid JSON'
  }
  if ($document.format -ne 'excubitor-netwatch-blocks' -or $document.version -ne 1) { throw 'blocks file has an unknown format' }
  return @($document.blocks)
}

try {
  $blocks = Read-Blocks
} catch {
  Write-Status @() @() ([string]$_.Exception.Message)
  exit 1
}

$now = [DateTimeOffset]::UtcNow
$desired = @{}
$rejected = New-Object System.Collections.Generic.List[object]
# @implements SPEC-EX-NETWATCH
foreach ($block in $blocks) {
  # A malformed entry (missing fields under StrictMode) must not stop the other entries.
  $id = ''
  try {
    $id = [string]$block.id
    if ($id -notmatch $IdPattern) { continue }
    $expires = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$block.expires_at, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$expires)) {
      $rejected.Add([ordered]@{ id = $id; reason = 'expires_at is not a date' })
      continue
    }
    if ($expires -le $now) { continue }
    $reason = Get-RejectReason $block
    if ($null -ne $reason) {
      $rejected.Add([ordered]@{ id = $id; reason = $reason })
      continue
    }
    if ($desired.Count -ge $MaxBlocks) {
      $rejected.Add([ordered]@{ id = $id; reason = 'too many blocks' })
      continue
    }
    $desired[$id] = [pscustomobject]@{
      Kind = [string]$block.kind
      Value = [string]$block.value
      Fingerprint = 'kind=' + [string]$block.kind + ';value=' + [string]$block.value
    }
  } catch {
    if ($id -match $IdPattern) { $rejected.Add([ordered]@{ id = $id; reason = 'malformed entry' }) }
    continue
  }
}

$present = @{}
# @implements SPEC-EX-NETWATCH
foreach ($rule in @(Get-NetFirewallRule -Group $GroupName -ErrorAction SilentlyContinue)) {
  if (-not $rule.Name.StartsWith($RulePrefix)) { continue }
  $id = $rule.Name.Substring($RulePrefix.Length)
  $wanted = $desired[$id]
  if ($null -eq $wanted -or $rule.Description -ne $wanted.Fingerprint) {
    Remove-NetFirewallRule -Name $rule.Name
    continue
  }
  $present[$id] = $true
}

$applied = New-Object System.Collections.Generic.List[string]
# @implements SPEC-EX-NETWATCH
foreach ($id in $desired.Keys) {
  if ($present.ContainsKey($id)) {
    $applied.Add($id)
    continue
  }
  $wanted = $desired[$id]
  $parameters = @{
    Name        = $RulePrefix + $id
    DisplayName = 'Excubitor netwatch block ' + $id
    Group       = $GroupName
    Description = $wanted.Fingerprint
    Direction   = 'Outbound'
    Action      = 'Block'
    Profile     = 'Any'
    Enabled     = 'True'
  }
  if ($wanted.Kind -eq 'address') { $parameters.RemoteAddress = $wanted.Value } else { $parameters.Program = $wanted.Value }
  try {
    New-NetFirewallRule @parameters | Out-Null
    $applied.Add($id)
  } catch {
    $rejected.Add([ordered]@{ id = $id; reason = 'firewall rejected the rule: ' + $_.Exception.Message })
  }
}

Write-Status $applied.ToArray() $rejected.ToArray() $null
