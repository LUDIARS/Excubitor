/** Scalar projection avoids recursively serializing SID/CIM metadata and exceeding the collector deadline. */
export const WINDOWS_INVENTORY_COMMAND = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$u=@(Get-LocalUser | Sort-Object Name | ForEach-Object {
  [ordered]@{name=$_.Name;enabled=$_.Enabled;sid=$_.SID.Value}
})
$t=@(Get-ScheduledTask | Sort-Object TaskPath,TaskName | ForEach-Object {
  [ordered]@{path=$_.TaskPath;name=$_.TaskName;actions=@($_.Actions | ForEach-Object {
    [ordered]@{type=$_.CimClass.CimClassName;id=$_.Id;execute=$_.Execute;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory;classId=$_.ClassId;data=$_.Data}
  })}
})
$r=@(foreach($p in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Run','HKCU:\Software\Microsoft\Windows\CurrentVersion\Run')) {
  if(Test-Path $p) {
    $values=Get-ItemProperty $p
    foreach($property in ($values.PSObject.Properties | Where-Object { $_.Name -notin @('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider') } | Sort-Object Name)) {
      [ordered]@{path=$p;name=$property.Name;value=$property.Value}
    }
  }
})
@{users=$u;tasks=$t;autorun=$r} | ConvertTo-Json -Depth 6 -Compress
`;
