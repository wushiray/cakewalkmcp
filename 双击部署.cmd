@echo off
setlocal
chcp 65001 >nul
title Cakewalk MCP deploy
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\double-click.ps1"
set "deploy_result=%errorlevel%"
echo.
if not "%deploy_result%"=="0" echo Deployment did not finish. See the errors above and the log file.
echo Press any key to close this window...
pause >nul
exit /b %deploy_result%
