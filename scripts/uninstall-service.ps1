param(
  [string]$Name = "Excubitor"
)

$ErrorActionPreference = 'Continue'
$Nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
if ($Nssm) {
  & $Nssm.Source stop $Name
  & $Nssm.Source remove $Name confirm
}

if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Name
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
}

Write-Host "Removed service/task '$Name' if it existed."
