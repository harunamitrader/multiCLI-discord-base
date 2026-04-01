@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
set "ENV_PATH=%PROJECT_ROOT%\.env"
set "HOST=127.0.0.1"
set "PORT=3087"

if exist "%ENV_PATH%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_PATH%") do (
    if /i "%%A"=="HOST" set "HOST=%%B"
    if /i "%%A"=="PORT" set "PORT=%%B"
  )
)

set "BASE_URL=http://%HOST%:%PORT%"
set "HEALTH_URL=%BASE_URL%/api/health"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  start "CoDiCoDi Server" cmd.exe /k "cd /d ""%PROJECT_ROOT%"" && call scripts\start-server.cmd"

  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ready = $false; for ($i = 0; $i -lt 60; $i++) { try { $r = Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}; Start-Sleep -Seconds 1 }; if (-not $ready) { exit 1 }"
  if errorlevel 1 (
    echo CoDiCoDi server did not become ready: %HEALTH_URL%
    pause
    exit /b 1
  )
)

start "" "%BASE_URL%"
exit /b 0
