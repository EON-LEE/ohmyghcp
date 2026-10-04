<#
.SYNOPSIS
  End-to-end test: GitHub Copilot CLI runs OMC's ralph loop through the installed oh-my-ghcp plugin.
.DESCRIPTION
  Copies tests\fixtures\ralph-sandbox (a tiny repo with a failing test) to a run directory, runs
  copilot -p "ralph: ..." with the plugin from scripts\install.ps1 and checks the run with tests\e2e-check.cjs.
  Makes real model calls (default gpt-5-mini, also pinned for subagents). On paid Copilot plans gpt-5-mini used no
  premium requests in our runs, but each run used about 4 to 10 AI credits (AIC). Copilot runs with an isolated
  COPILOT_HOME inside the run directory, so your Copilot settings, sessions and
  OMC state are not touched. Authentication: COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN, else `gh auth token`.
.EXAMPLE
  pwsh -File tests\e2e-ralph.ps1
#>
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Model = 'gpt-5-mini',
  [string]$Prompt = 'ralph: make the failing test in this repo pass (check with: node test.js).',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

if (-not $Root) {
  $base = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
  $Root = Join-Path $base 'oh-my-ghcp'
}
$Root = [IO.Path]::GetFullPath($Root)
$plugin = Join-Path $Root 'plugin'
$bin = Join-Path $Root 'bin'
foreach ($p in @((Join-Path $plugin 'ghcp-shim.cjs'), (Join-Path $bin 'omc.cmd'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "oh-my-ghcp is not installed at $Root ($p missing); run scripts\install.ps1 first" }
}
if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) { throw 'GitHub Copilot CLI (copilot) was not found on PATH' }
if (-not $OutDir) { $OutDir = Join-Path ([IO.Path]::GetTempPath()) ('oh-my-ghcp-e2e-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (Test-Path -LiteralPath $OutDir) { throw "run directory already exists: $OutDir" }
$sandbox = Join-Path $OutDir 'sandbox'
$copilotHome = Join-Path $OutDir 'copilot-home'
New-Item -ItemType Directory -Path $OutDir, $copilotHome | Out-Null

function Invoke-Quiet {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Exe @Arguments 2>&1 | Out-String } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE`n$out" }
}

# Paths OMC writes under CLAUDE_CONFIG_DIR (default ~/.claude); oh-my-ghcp redirects it, so these must not change.
function Get-ClaudeHomeState([string]$HomeDir) {
  $state = [ordered]@{}
  foreach ($rel in @('.claude\settings.json', '.claude\CLAUDE.md', '.claude\.session-stats.json', '.claude\.omc',
      '.claude\hooks', '.claude\hud')) {
    $p = Join-Path $HomeDir $rel
    $state[$rel] = if (Test-Path -LiteralPath $p) { [string](Get-Item -LiteralPath $p -Force).LastWriteTimeUtc.Ticks } else { 'missing' }
  }
  $state
}

# OMC's SessionEnd hook starts detached node workers whose command line carries the project directory.
function Get-SessionEndWorkerCount([string]$Tag) {
  try {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($Tag) -and $_.CommandLine.Contains('session-end') }).Count
  } catch { -1 }
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\ralph-sandbox') -Destination $sandbox -Recurse
Invoke-Quiet git @('-c', 'init.defaultBranch=main', 'init', '-q', $sandbox)
Invoke-Quiet git @('-C', $sandbox, 'add', '-A')
Invoke-Quiet git @('-C', $sandbox, '-c', 'user.name=oh-my-ghcp e2e', '-c', 'user.email=e2e@oh-my-ghcp.invalid', 'commit', '-q', '-m', 'fixture')

$saved = @{}
foreach ($k in @('COPILOT_HOME', 'GH_TOKEN', 'GHCP_SHIM_LOG', 'GHCP_TASK_MODEL', 'PATH', 'COPILOT_AGENT_SESSION_ID',
    'OMC_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'OMC_STATE_DIR')) {
  $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
}
$savedEncoding = $null
$sessionId = [guid]::NewGuid().ToString()
$realHome = [Environment]::GetFolderPath('UserProfile')
$omcHome = Join-Path $realHome '.omc'
$omcHomeBefore = Test-Path -LiteralPath $omcHome
$claudeBefore = Get-ClaudeHomeState $realHome
try {
  if (-not ($env:COPILOT_GITHUB_TOKEN -or $env:GH_TOKEN -or $env:GITHUB_TOKEN)) {
    $token = $null
    if (Get-Command gh -ErrorAction SilentlyContinue) {
      $eap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { $token = (& gh auth token 2>$null | Out-String).Trim() } finally { $ErrorActionPreference = $eap }
    }
    if (-not $token) { throw 'no Copilot credentials: set GH_TOKEN (or COPILOT_GITHUB_TOKEN) or log in with gh auth login' }
    $env:GH_TOKEN = $token
  }
  $env:COPILOT_HOME = $copilotHome
  $env:GHCP_SHIM_LOG = Join-Path $OutDir 'shim.log'
  $env:GHCP_TASK_MODEL = $Model
  $env:PATH = "$bin;$env:PATH"
  foreach ($k in @('COPILOT_AGENT_SESSION_ID', 'OMC_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'OMC_STATE_DIR')) {
    Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue
  }
  try {
    $savedEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  } catch { $savedEncoding = $null }

  $copilotVersion = ''
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $copilotVersion = (& copilot --version 2>$null | Select-Object -First 1 | Out-String).Trim() } finally { $ErrorActionPreference = $eap }
  $cli = @('-p', $Prompt, '--model', $Model, '--allow-all', '--no-custom-instructions', '--output-format', 'json',
    '--log-dir', (Join-Path $OutDir 'logs'), '--plugin-dir', $plugin, '--session-id', $sessionId)
  Write-Host "running Copilot CLI ($copilotVersion, $Model) on $sandbox; this takes several minutes"
  Push-Location -LiteralPath $sandbox
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ErrorActionPreference = 'Continue'
    & copilot @cli 1> (Join-Path $OutDir 'stdout.jsonl') 2> (Join-Path $OutDir 'stderr.txt')
    $copilotExit = $LASTEXITCODE
    $wall = [int]$sw.Elapsed.TotalSeconds
    & node test.js *> (Join-Path $OutDir 'test-after.txt')
    $testExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
  } finally {
    Pop-Location
  }

  # The workers keep writing .omc state after copilot exits; let them finish before copying and checking.
  $tag = Split-Path -Leaf $OutDir
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $workers = Get-SessionEndWorkerCount $tag
  while ($workers -gt 0 -and $sw.Elapsed.TotalSeconds -lt 120) {
    Start-Sleep -Milliseconds 500
    $workers = Get-SessionEndWorkerCount $tag
  }
  if ($workers -lt 0) { Start-Sleep -Seconds 5 }
  $workerNote = if ($workers -lt 0) { 'unknown (process list unavailable)' }
    elseif ($workers -gt 0) { "$workers still running after 120s" }
    else { "none running $([int]$sw.Elapsed.TotalSeconds)s after copilot exited" }

  $transcript = Join-Path $copilotHome "session-state\$sessionId\events.jsonl"
  if (Test-Path -LiteralPath $transcript) { Copy-Item -LiteralPath $transcript -Destination (Join-Path $OutDir 'transcript-events.jsonl') }
  $omcState = Join-Path $sandbox '.omc'
  if (Test-Path -LiteralPath $omcState) { Copy-Item -LiteralPath $omcState -Destination (Join-Path $OutDir 'sandbox-omc') -Recurse }

  $claudeAfter = Get-ClaudeHomeState $realHome
  $claudeDiff = @($claudeBefore.Keys | Where-Object { $claudeBefore[$_] -ne $claudeAfter[$_] } |
      ForEach-Object { "$_ $($claudeBefore[$_]) -> $($claudeAfter[$_])" })
  # ~/.omc is OMC's global directory (shared with OMC on Claude Code); restore its pre-test absence.
  $omcHomeNote = 'not created'
  if ($omcHomeBefore) {
    $omcHomeNote = 'existed before the run; left in place'
  } elseif (Test-Path -LiteralPath $omcHome) {
    Copy-Item -LiteralPath $omcHome -Destination (Join-Path $OutDir 'home-omc') -Recurse
    Remove-Item -LiteralPath $omcHome -Recurse -Force
    $omcHomeNote = 'created by OMC during the run; copied to home-omc and removed (it did not exist before)'
  }
  $run = [ordered]@{
    exit = $copilotExit; testExit = $testExit; wallSeconds = $wall; model = $Model; taskModel = $Model; sessionId = $sessionId
    copilotVersion = $copilotVersion; root = $Root; prompt = $Prompt
    realClaudeUnchanged = ($claudeDiff.Count -eq 0); realClaudeDiff = ($claudeDiff -join '; ')
    omcHome = $omcHomeNote; sessionEndWorkers = $workerNote
  }
  [IO.File]::WriteAllText((Join-Path $OutDir 'run.json'), ($run | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
} finally {
  if ($null -ne $savedEncoding) { try { [Console]::OutputEncoding = $savedEncoding } catch { } }
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  if (-not $omcHomeBefore -and (Test-Path -LiteralPath $omcHome)) {
    Remove-Item -LiteralPath $omcHome -Recurse -Force -ErrorAction SilentlyContinue
  }
}

& node (Join-Path $PSScriptRoot 'e2e-check.cjs') $OutDir
$checkExit = $LASTEXITCODE
Write-Host "run directory: $OutDir"
exit $checkExit
