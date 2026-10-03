@echo off
setlocal
rem oh-my-ghcp: runs the OMC CLI of the oh-my-ghcp plugin (installed at %~dp0..\plugin) with Copilot-side state dirs.
if not defined CLAUDE_CONFIG_DIR if defined COPILOT_HOME set "CLAUDE_CONFIG_DIR=%COPILOT_HOME%\oh-my-ghcp\claude"
if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.copilot\oh-my-ghcp\claude"
set "GHCP_STATE=%USERPROFILE%\.copilot\oh-my-ghcp\state"
if defined COPILOT_HOME set "GHCP_STATE=%COPILOT_HOME%\oh-my-ghcp\state"
rem Map the Copilot session id only when the shim saw it as a main session (subagent shells carry a different id).
if not defined OMC_SESSION_ID if defined COPILOT_AGENT_SESSION_ID if exist "%GHCP_STATE%\note\%COPILOT_AGENT_SESSION_ID%.json" if not exist "%GHCP_STATE%\alias\%COPILOT_AGENT_SESSION_ID%.json" set "OMC_SESSION_ID=%COPILOT_AGENT_SESSION_ID%"
node "%~dp0..\plugin\bin\oh-my-claudecode.js" %*
exit /b %ERRORLEVEL%
