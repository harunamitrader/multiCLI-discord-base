$ErrorActionPreference = "Stop"

$installerDir = Join-Path $env:TEMP "tauri-build-tools"
$installerPath = Join-Path $installerDir "vs_BuildTools.exe"
$installerUrl = "https://aka.ms/vs/17/release/vs_BuildTools.exe"

New-Item -ItemType Directory -Force -Path $installerDir | Out-Null

Write-Host "Downloading Visual Studio Build Tools installer..."
Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath

$arguments = @(
  "install"
  "--passive"
  "--wait"
  "--norestart"
  "--nocache"
  "--includeRecommended"
  "--add", "Microsoft.VisualStudio.Workload.VCTools"
  "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621"
)

Write-Host "Launching installer with elevation..."
Start-Process -FilePath $installerPath -ArgumentList $arguments -Verb RunAs -Wait

Write-Host "Build Tools installer finished."
