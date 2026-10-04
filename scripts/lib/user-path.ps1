# oh-my-ghcp: user PATH helpers for Windows (Windows PowerShell 5.1 and PowerShell 7).
# The user Path is read and written raw so REG_EXPAND_SZ entries such as %USERPROFILE%\bin stay unexpanded.

function Get-OmgUserPathEntries {
  param([string]$KeyPath = 'Environment')
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($KeyPath, $false)
  if (-not $key) { return @() }
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally { $key.Close() }
  return @($raw -split ';' | Where-Object { $_ })
}

function Test-OmgSamePath {
  param([string]$A, [string]$B)
  return [Environment]::ExpandEnvironmentVariables($A).TrimEnd('\') -ieq [Environment]::ExpandEnvironmentVariables($B).TrimEnd('\')
}

function Set-OmgUserPath {
  param([string]$KeyPath, [string[]]$Entries)
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($KeyPath)
  try {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $key.SetValue('Path', ($Entries -join ';'), $kind)
  } finally { $key.Close() }
  if ($KeyPath -eq 'Environment') { Send-OmgSettingChange }
}

# Returns $true when the directory was added, $false when it was already there.
function Add-OmgUserPath {
  param([Parameter(Mandatory = $true)][string]$Dir, [string]$KeyPath = 'Environment')
  $entries = @(Get-OmgUserPathEntries -KeyPath $KeyPath)
  foreach ($e in $entries) { if (Test-OmgSamePath $e $Dir) { return $false } }
  Set-OmgUserPath -KeyPath $KeyPath -Entries ($entries + $Dir)
  return $true
}

# Returns $true when the directory was removed, $false when it was not there.
function Remove-OmgUserPath {
  param([Parameter(Mandatory = $true)][string]$Dir, [string]$KeyPath = 'Environment')
  $entries = @(Get-OmgUserPathEntries -KeyPath $KeyPath)
  $kept = @($entries | Where-Object { -not (Test-OmgSamePath $_ $Dir) })
  if ($kept.Count -eq $entries.Count) { return $false }
  Set-OmgUserPath -KeyPath $KeyPath -Entries $kept
  return $true
}

# Tells Explorer (and shells it starts later) that the user environment changed.
function Send-OmgSettingChange {
  try {
    if (-not ('OhMyGhcp.NativeMethods' -as [type])) {
      Add-Type -Namespace OhMyGhcp -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][OhMyGhcp.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    Write-Verbose "WM_SETTINGCHANGE broadcast failed: $_"
  }
}
