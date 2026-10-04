<#
.SYNOPSIS
  Tests scripts\lib\user-path.ps1 against a throwaway registry key (HKCU\Software\oh-my-ghcp-test-<random>).
  Your real user PATH is not read or written. Works in Windows PowerShell 5.1 and PowerShell 7.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tests\user-path.test.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
. (Join-Path $PSScriptRoot '..\scripts\lib\user-path.ps1')

$keyPath = 'Software\oh-my-ghcp-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$script:failed = 0
$script:total = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $script:total++
  if (-not $Ok) { $script:failed++ }
  $suffix = if ($Detail) { " ($Detail)" } else { '' }
  Write-Host ("{0} {1}{2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $suffix)
}
function Get-Raw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false)
  try {
    $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($key.GetValueNames() -contains 'Path') { [string]$key.GetValueKind('Path') } else { 'none' }
    [pscustomobject]@{ Value = $value; Kind = $kind }
  } finally { $key.Close() }
}
function Set-Raw([string]$Value, [Microsoft.Win32.RegistryValueKind]$Kind) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
  try { $key.SetValue('Path', $Value, $Kind) } finally { $key.Close() }
}

$bin = 'C:\oh-my-ghcp-test\bin'
$original = '%USERPROFILE%\bin;C:\tools'
try {
  Write-Host "== user-path.ps1 on HKCU\$keyPath (PowerShell $($PSVersionTable.PSVersion))"
  Check 'missing key reads as no entries' (@(Get-OmgUserPathEntries -KeyPath $keyPath).Count -eq 0)

  Set-Raw $original ([Microsoft.Win32.RegistryValueKind]::ExpandString)
  Check 'add a new directory returns true' ((Add-OmgUserPath -Dir $bin -KeyPath $keyPath) -eq $true)
  $raw = Get-Raw
  Check 'entry appended, %USERPROFILE% kept unexpanded' ($raw.Value -eq "$original;$bin") $raw.Value
  Check 'value kind stays REG_EXPAND_SZ' ($raw.Kind -eq 'ExpandString') $raw.Kind
  Check 'adding it again returns false' ((Add-OmgUserPath -Dir $bin -KeyPath $keyPath) -eq $false)
  Check 'trailing backslash and case are the same directory' ((Add-OmgUserPath -Dir ($bin.ToUpper() + '\') -KeyPath $keyPath) -eq $false)
  Check 'expanded form of an existing %VAR% entry is the same directory' (
    (Add-OmgUserPath -Dir ([Environment]::ExpandEnvironmentVariables('%USERPROFILE%\bin')) -KeyPath $keyPath) -eq $false)
  Check 'still exactly one copy' ((Get-Raw).Value -eq "$original;$bin") (Get-Raw).Value

  Check 'remove returns true' ((Remove-OmgUserPath -Dir "$bin\" -KeyPath $keyPath) -eq $true)
  Check 'other entries restored exactly' ((Get-Raw).Value -eq $original) (Get-Raw).Value
  Check 'removing it again returns false' ((Remove-OmgUserPath -Dir $bin -KeyPath $keyPath) -eq $false)

  Set-Raw 'C:\tools' ([Microsoft.Win32.RegistryValueKind]::String)
  [void](Add-OmgUserPath -Dir $bin -KeyPath $keyPath)
  Check 'REG_SZ value kind is preserved' ((Get-Raw).Kind -eq 'String') (Get-Raw).Kind

  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
  try { $key.DeleteValue('Path') } finally { $key.Close() }
  [void](Add-OmgUserPath -Dir $bin -KeyPath $keyPath)
  $raw = Get-Raw
  Check 'missing Path value is created as REG_EXPAND_SZ' ($raw.Value -eq $bin -and $raw.Kind -eq 'ExpandString') "$($raw.Kind) $($raw.Value)"
  Check 'removing the only entry leaves an empty Path' ((Remove-OmgUserPath -Dir $bin -KeyPath $keyPath) -eq $true -and (Get-Raw).Value -eq '') (Get-Raw).Value

  Send-OmgSettingChange
  Check 'WM_SETTINGCHANGE helper compiles and runs' ($null -ne ('OhMyGhcp.NativeMethods' -as [type]))
} finally {
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyPath, $false)
}
Check 'test key removed' ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath))
Write-Host ''
if ($script:failed) { Write-Host "$script:failed of $script:total checks FAILED"; exit 1 }
Write-Host "all $script:total checks passed"
