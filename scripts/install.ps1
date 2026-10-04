<#
.SYNOPSIS
  Installs oh-my-ghcp: oh-my-claudecode (OMC) running on GitHub Copilot CLI (Windows).
.DESCRIPTION
  Clones the OMC release pinned in upstream.json, verifies its commit, installs OMC's runtime dependencies, builds
  the Copilot plugin with adapter\build-overlay.cjs and installs the copilot-omc and omc commands. Everything goes
  under <COPILOT_HOME>\oh-my-ghcp (default %USERPROFILE%\.copilot\oh-my-ghcp); OMC itself is not modified.
  Re-running updates the plugin in place and keeps OMC state (state\, claude\).
.PARAMETER OmcRef
  Install this OMC tag or branch instead of the pinned release (its commit is not verified).
.PARAMETER AgentModel
  Copilot model id for OMC agent definitions (default: none, agents run on the session model).
.PARAMETER TaskModel
  Pin every OMC subagent (task tool) to this Copilot model id.
.PARAMETER TaskModelMap
  Map OMC's Claude tiers to Copilot models, e.g. "opus=claude-opus-4.6,sonnet=claude-sonnet-4.6,haiku=gpt-5-mini".
.PARAMETER RebuildCli
  Rebuild OMC's CLI bundle from source (only needed for OMC v5.6.0, whose bundle lacks "omc ralph").
.PARAMETER Force
  Re-clone OMC and reinstall its dependencies even when the pinned commit is already installed.
.PARAMETER NoPath
  Do not add the commands directory to the user PATH.
.PARAMETER Uninstall
  Remove <COPILOT_HOME>\oh-my-ghcp (including OMC state kept there) and its user PATH entry.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
[CmdletBinding()]
param(
  [string]$OmcRef,
  [string]$AgentModel,
  [string]$TaskModel,
  [string]$TaskModelMap,
  [switch]$RebuildCli,
  [switch]$Force,
  [switch]$NoPath,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { throw 'oh-my-ghcp: on Linux or macOS run scripts/install.sh' }
. (Join-Path $PSScriptRoot 'lib\user-path.ps1')

$repo = Split-Path -Parent $PSScriptRoot
$copilotHome = $env:COPILOT_HOME
if (-not $copilotHome) { $copilotHome = Join-Path $env:USERPROFILE '.copilot' }
$root = Join-Path $copilotHome 'oh-my-ghcp'
$omcDir = Join-Path $root 'omc'
$pluginDir = Join-Path $root 'plugin'
$binDir = Join-Path $root 'bin'
$verifiedCopilot = [version]'1.0.91'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# Runs a native command. Its output is shown (indented) unless -Quiet, and always when it fails; failure throws.
function Invoke-Native {
  param([string]$What, [scriptblock]$Command, [switch]$Quiet)
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  $lines = @(& $Command 2>&1 | ForEach-Object { "$_" })
  $code = $global:LASTEXITCODE
  if (-not $Quiet -or $code -ne 0) { foreach ($l in $lines) { Write-Host "    $l" } }
  if ($code -ne 0) { throw "oh-my-ghcp: $What failed (exit code $code)" }
}

# Returns the trimmed stdout of a native command, or $null when it fails.
function Get-NativeOutput {
  param([scriptblock]$Command)
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  try { $out = @(& $Command 2>$null) } catch { return $null }
  if ($global:LASTEXITCODE -ne 0) { return $null }
  return (($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Test-ReparsePoint([string]$Path) {
  try { return ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0 } catch { return $false }
}

# The plugin shares OMC's node_modules through a junction. Windows PowerShell's Remove-Item -Recurse follows junctions,
# so unlink it before deleting anything around it.
function Remove-PluginLink {
  $link = Join-Path $pluginDir 'node_modules'
  if (Test-ReparsePoint $link) { [IO.Directory]::Delete($link) }
}

if ($Uninstall) {
  Write-Step "removing $root"
  Remove-PluginLink
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  if (Remove-OmgUserPath -Dir $binDir) { Write-Host "    removed $binDir from the user PATH" }
  Write-Host 'oh-my-ghcp removed. Copilot CLI and per-project .omc\ directories were left as they are.'
  return
}

Write-Step 'checking prerequisites'
foreach ($cmd in 'node', 'git') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "oh-my-ghcp: '$cmd' was not found on PATH" }
}
$npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
if (-not $npm) { throw "oh-my-ghcp: 'npm' was not found on PATH" }
$npm = $npm.Source
$nodeVersion = Get-NativeOutput { node -p 'process.versions.node' }
if (-not $nodeVersion -or [int]($nodeVersion.Split('.')[0]) -lt 20) { throw "oh-my-ghcp: Node.js 20 or newer is required (found '$nodeVersion')" }
$copilotVersion = $null
if (Get-Command copilot -ErrorAction SilentlyContinue) {
  $copilotVersion = ([regex]'\d+\.\d+\.\d+').Match([string](Get-NativeOutput { copilot --version })).Value
}
if (-not $copilotVersion) {
  Write-Warning 'GitHub Copilot CLI (copilot) was not found; install it first: winget install GitHub.Copilot'
} elseif ([version]$copilotVersion -lt $verifiedCopilot) {
  Write-Warning "Copilot CLI $copilotVersion is older than $verifiedCopilot, the version oh-my-ghcp was verified with; run: copilot update"
}
Write-Host "    node $nodeVersion, Copilot CLI $(if ($copilotVersion) { $copilotVersion } else { 'missing' })"

$upstream = Get-Content -Raw -LiteralPath (Join-Path $repo 'upstream.json') | ConvertFrom-Json
$ref = $upstream.tag
$wantCommit = $upstream.commit
if ($OmcRef) { $ref = $OmcRef; $wantCommit = $null }
$haveCommit = $null
if (Test-Path -LiteralPath (Join-Path $omcDir '.git')) { $haveCommit = Get-NativeOutput { git -C $omcDir rev-parse HEAD } }
$fresh = $Force -or $OmcRef -or -not $haveCommit -or $haveCommit -ne $wantCommit

try {
  if ($fresh) {
    if (Test-Path -LiteralPath $omcDir) {
      if (-not (Test-Path -LiteralPath (Join-Path $omcDir '.claude-plugin\plugin.json'))) {
        throw "oh-my-ghcp: $omcDir exists but is not an OMC checkout; move it away and run again"
      }
      Write-Step 'removing the previous OMC checkout'
      Remove-PluginLink
      Remove-Item -LiteralPath $omcDir -Recurse -Force
    }
    Write-Step "cloning oh-my-claudecode $ref"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Invoke-Native "git clone ($ref)" { git -c advice.detachedHead=false clone --quiet --depth 1 --branch $ref $upstream.repository $omcDir } -Quiet
    $haveCommit = Get-NativeOutput { git -C $omcDir rev-parse HEAD }
    if ($wantCommit -and $haveCommit -ne $wantCommit) {
      Remove-Item -LiteralPath $omcDir -Recurse -Force
      throw "oh-my-ghcp: OMC $ref resolved to $haveCommit, but upstream.json pins $wantCommit; not installing it"
    }
  } else {
    Write-Step "oh-my-claudecode $ref ($($haveCommit.Substring(0, 12))) already installed"
  }

  if ($fresh -or -not (Test-Path -LiteralPath (Join-Path $omcDir 'node_modules\commander\package.json'))) {
    Write-Step 'installing OMC runtime dependencies (npm, production only)'
    Push-Location -LiteralPath $omcDir
    try {
      try {
        Invoke-Native 'npm ci' { & $npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error } -Quiet
      } catch {
        Write-Host '    npm ci failed; retrying with npm install'
        Invoke-Native 'npm install' { & $npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error } -Quiet
      }
      # Same as OMC's own plugin setup: lifecycle scripts stay off except for this one native module.
      try {
        Invoke-Native 'npm rebuild better-sqlite3' { & $npm rebuild better-sqlite3 --loglevel=error } -Quiet
      } catch {
        Write-Warning "better-sqlite3 was not built; OMC falls back to file locks for its state ($($_.Exception.Message))"
      }
    } finally { Pop-Location }
  }

  Write-Step "building the Copilot plugin in $pluginDir"
  $buildArgs = @((Join-Path $repo 'adapter\build-overlay.cjs'), '--omc', $omcDir, '--out', $pluginDir, '--force')
  if ($AgentModel) { $buildArgs += @('--agent-model', $AgentModel) }
  if ($TaskModel) { $buildArgs += @('--task-model', $TaskModel) }
  if ($TaskModelMap) { $buildArgs += @('--task-model-map', $TaskModelMap) }
  if ($RebuildCli) {
    $esbuildVersion = (Get-Content -Raw -LiteralPath (Join-Path $omcDir 'package.json') | ConvertFrom-Json).devDependencies.esbuild
    if (-not $esbuildVersion) { throw 'oh-my-ghcp: OMC package.json has no esbuild devDependency; -RebuildCli is not supported for this OMC version' }
    $tools = Join-Path $root 'tools'
    Invoke-Native "npm install esbuild@$esbuildVersion" { & $npm install --prefix $tools "esbuild@$esbuildVersion" --no-audit --no-fund --loglevel=error } -Quiet
    $buildArgs += @('--rebuild-cli', '--esbuild', (Join-Path $tools 'node_modules\esbuild'))
  }
  Invoke-Native 'plugin build' { node @buildArgs }

  Write-Step "installing commands in $binDir"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  foreach ($f in 'copilot-omc.cmd', 'omc.cmd') {
    Copy-Item -LiteralPath (Join-Path $repo "adapter\$f") -Destination (Join-Path $binDir $f) -Force
  }
} catch {
  if ("$_" -match 'being used by another process|denied') {
    Write-Warning 'files are in use: close running Copilot CLI sessions that load oh-my-ghcp, then run the installer again'
  }
  throw
}

Write-Step 'smoke test: omc --version'
$omcCmd = Join-Path $binDir 'omc.cmd'
$omcVersion = Get-NativeOutput { & $omcCmd --version }
if ($omcVersion) { Write-Host "    omc $omcVersion" } else { Write-Warning 'omc --version failed; OMC hooks and skills inside Copilot may still work, but the omc CLI does not' }
if (-not (Get-NativeOutput { & $omcCmd ralph --help })) { Write-Warning 'this OMC build has no "omc ralph" command; reinstall with -RebuildCli' }

$launcher = "& '$(Join-Path $binDir 'copilot-omc.cmd')'"
if (-not $NoPath) {
  if (Add-OmgUserPath -Dir $binDir) { Write-Host "    added $binDir to the user PATH (new terminals pick it up)" }
  if (-not (@($env:Path -split ';') | Where-Object { $_ -and (Test-OmgSamePath $_ $binDir) })) { $env:Path = "$binDir;$env:Path" }
  $launcher = 'copilot-omc'
}

$info = Get-Content -Raw -LiteralPath (Join-Path $pluginDir 'oh-my-ghcp.json') | ConvertFrom-Json
$commit = if ($info.omc.commit) { " ($($info.omc.commit.Substring(0, 12)))" } else { '' }
Write-Host ''
Write-Host "oh-my-ghcp is ready: oh-my-claudecode $($info.omc.version)$commit for GitHub Copilot CLI" -ForegroundColor Green
Write-Host "  start Copilot with OMC:  $launcher            (any copilot options work, e.g. --model)"
Write-Host "  one-shot:                $launcher -p `"ralph: make the failing tests pass`" --allow-all"
Write-Host "  without the launcher:    copilot --plugin-dir `"$pluginDir`""
Write-Host '  in the session, use /omc ralph <task> (or /ralph); keyword prompts like ralph: also work; stop with cancelomc'
