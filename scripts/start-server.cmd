@echo off
cd /d "%~dp0.."
set "ENV_PATH=%CD%\.env"
set "HOST=127.0.0.1"
set "PORT=3087"
set "HEALTH_URL="

if exist "%ENV_PATH%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_PATH%") do (
    if /i "%%A"=="HOST" set "HOST=%%B"
    if /i "%%A"=="PORT" set "PORT=%%B"
  )
)

set "HEALTH_URL=http://%HOST%:%PORT%/api/health"

:loop
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$healthUrl = '%HEALTH_URL%'; for ($i = 0; $i -lt 120; $i++) { try { $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { [Console]::Title = 'codicodi server'; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 0"

node --env-file-if-exists=.env server/src/index.js

if %ERRORLEVEL% EQU 42 (
  echo.
  echo [RESTART] Restarting CoDiCoDi in 3 seconds...
  timeout /t 3 /nobreak >nul
  goto loop
)
