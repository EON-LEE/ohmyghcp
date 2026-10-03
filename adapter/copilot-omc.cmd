@echo off
setlocal
rem oh-my-ghcp: starts GitHub Copilot CLI with the oh-my-ghcp plugin loaded and the omc command on PATH.
rem Arguments are passed to copilot unchanged (copilot-omc -p "...", copilot-omc --model gpt-5-mini, ...).
for %%I in ("%~dp0.") do set "OMC_GHCP_BIN=%%~fI"
for %%I in ("%~dp0..\plugin") do set "OMC_GHCP_PLUGIN=%%~fI"
if not exist "%OMC_GHCP_PLUGIN%\ghcp-shim.cjs" (
  echo oh-my-ghcp: plugin not found at "%OMC_GHCP_PLUGIN%"; run scripts\install.ps1 again. 1>&2
  exit /b 1
)
set "PATH=%OMC_GHCP_BIN%;%PATH%"
copilot --plugin-dir "%OMC_GHCP_PLUGIN%" %*
exit /b %ERRORLEVEL%
