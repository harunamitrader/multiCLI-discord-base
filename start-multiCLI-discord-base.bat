@echo off
cd /d "%~dp0"
set "PWSH_EXE=C:\Program Files\PowerShell\7\pwsh.exe"
if not exist "%PWSH_EXE%" set "PWSH_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PWSH_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-multiCLI-discord-base.ps1" -PauseOnError %*
exit /b %ERRORLEVEL%
