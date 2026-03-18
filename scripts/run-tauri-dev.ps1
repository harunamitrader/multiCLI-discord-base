$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

Set-Location $projectRoot

Write-Host "Checking Tauri environment..."
npx tauri info

Write-Host ""
Write-Host "Starting Tauri dev window..."
npm run tauri:dev
