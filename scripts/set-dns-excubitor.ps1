# @implements SPEC-EX-DNS-FILTER
# Point one network adapter's DNS servers at the Excubitor DNS filter, or put them back. Run from an
# elevated PowerShell. Excubitor must already be listening (GET /api/v1/dns-filter/status shows "running")
# on every address given here, otherwise name resolution on this PC stops.
#
#   .\scripts\set-dns-excubitor.ps1 -InterfaceAlias 'Ethernet'                       # 127.0.0.1 and ::1
#   .\scripts\set-dns-excubitor.ps1 -InterfaceAlias 'Ethernet' -Addresses 127.0.0.1
#   .\scripts\set-dns-excubitor.ps1 -InterfaceAlias 'Ethernet' -Revert               # back to DHCP / RA
#
# Both address families are set together: an adapter that keeps an IPv6 DNS server from the router
# would resolve around the filter. The previous servers are printed so they can be restored by hand.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InterfaceAlias,
  [string[]]$Addresses = @('127.0.0.1', '::1'),
  [switch]$Revert
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}

$adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
if (-not $adapter) { throw "No network adapter named '$InterfaceAlias' (see Get-NetAdapter)." }

function Show-DnsServers([string]$Label) {
  $lines = @(Get-DnsClientServerAddress -InterfaceAlias $InterfaceAlias | ForEach-Object {
    $family = if ($_.AddressFamily -eq 2) { 'IPv4' } else { 'IPv6' }
    '  {0}: {1}' -f $family, ($(if ($_.ServerAddresses.Count -gt 0) { $_.ServerAddresses -join ', ' } else { '(none)' }))
  })
  Write-Output "$Label DNS servers of '$InterfaceAlias':"
  $lines | Write-Output
}

Show-DnsServers 'Current'

if ($Revert) {
  Set-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -ResetServerAddresses
} else {
  if ($Addresses.Count -eq 0) { throw 'Give at least one address.' }
  $hasV4 = $false
  $hasV6 = $false
  # @implements SPEC-EX-DNS-FILTER
  foreach ($address in $Addresses) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($address, [ref]$parsed)) { throw "'$address' is not an IP address." }
    if ($parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { $hasV6 = $true } else { $hasV4 = $true }
  }
  if (-not ($hasV4 -and $hasV6)) {
    Write-Warning 'Only one address family is given. DNS servers of the other family stay as they are and can bypass the filter.'
  }
  Set-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -ServerAddresses $Addresses
}

Clear-DnsClientCache
Show-DnsServers 'New'
