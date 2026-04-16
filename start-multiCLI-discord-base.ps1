param(
  [switch]$SkipBrowser,
  [switch]$DryRun,
  [switch]$PauseOnError
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-LauncherColors {
  $psStyleAvailable = $null -ne (Get-Variable -Name PSStyle -Scope Global -ErrorAction SilentlyContinue)
  if (-not $psStyleAvailable) {
    return @{
      Accent = ""
      Ok = ""
      Warn = ""
      Muted = ""
      Reset = ""
    }
  }

  return @{
    Accent = $PSStyle.Foreground.BrightCyan
    Ok = $PSStyle.Foreground.BrightGreen
    Warn = $PSStyle.Foreground.BrightYellow
    Muted = $PSStyle.Foreground.BrightBlack
    Reset = $PSStyle.Reset
  }
}

function Ensure-ConsoleBindings {
  if ("MultiCliDiscordBase.NativeConsole" -as [type]) {
    return
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MultiCliDiscordBase {
  public static class NativeConsole {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
  }
}
"@
}

function Restore-ConsoleWindow {
  Ensure-ConsoleBindings
  $consoleHandle = [MultiCliDiscordBase.NativeConsole]::GetConsoleWindow()
  if ($consoleHandle -eq [IntPtr]::Zero) {
    return
  }

  [MultiCliDiscordBase.NativeConsole]::ShowWindowAsync($consoleHandle, 9) | Out-Null
  [MultiCliDiscordBase.NativeConsole]::SetForegroundWindow($consoleHandle) | Out-Null
}

function Set-LauncherTitle {
  param([string]$Title = "multiCLI-discord-base")

  $normalizedTitle = [string]$Title
  $normalizedTitle = $normalizedTitle.Trim()
  if (-not $normalizedTitle) {
    return
  }

  try {
    $Host.UI.RawUI.WindowTitle = $normalizedTitle
  } catch {
  }

  try {
    [Console]::Title = $normalizedTitle
  } catch {
  }

  try {
    [Console]::Out.Write(("`e]0;{0}`a" -f $normalizedTitle))
  } catch {
  }
}

function Wait-OnLauncherError {
  param(
    [string]$Message,
    [hashtable]$Colors
  )

  Write-Host ""
  Write-Host "$($Colors.Warn)[launcher] $Message$($Colors.Reset)"

  if ($PauseOnError) {
    Write-Host "$($Colors.Muted)Press Enter to close this window.$($Colors.Reset)"
    [void](Read-Host)
  }
}

function Read-LauncherConfig {
  param([string]$ProjectRoot)

  $config = @{
    Host = "127.0.0.1"
    Port = 3087
  }

  $envPath = Join-Path $ProjectRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    return $config
  }

  foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $parts = $trimmed -split "=", 2
    if ($parts.Length -ne 2) {
      continue
    }

    $key = $parts[0].Trim()
    $value = $parts[1].Trim()

    if ($key -eq "HOST" -and $value) {
      $config.Host = $value
      continue
    }

    if ($key -eq "PORT") {
      $parsedPort = 0
      if ([int]::TryParse($value, [ref]$parsedPort)) {
        $config.Port = $parsedPort
      }
    }
  }

  return $config
}

function Write-LauncherBanner {
  param(
    [hashtable]$Colors,
    [string]$ProjectRoot,
    [string]$BaseUrl,
    [string]$HealthUrl,
    [string]$UiUrl
  )

  Clear-Host
  Set-LauncherTitle -Title "multiCLI-discord-base"

  $line = "=" * 70
  Write-Host "$($Colors.Accent)$line$($Colors.Reset)"
  Write-Host "$($Colors.Accent)  multiCLI-discord-base Server Console$($Colors.Reset)"
  Write-Host "$($Colors.Accent)$line$($Colors.Reset)"
  Write-Host "$($Colors.Muted)  Project : $ProjectRoot$($Colors.Reset)"
  Write-Host "$($Colors.Muted)  Server  : $BaseUrl$($Colors.Reset)"
  Write-Host "$($Colors.Muted)  Health  : $HealthUrl$($Colors.Reset)"
  Write-Host "$($Colors.Muted)  UI      : $UiUrl$($Colors.Reset)"
  Write-Host "$($Colors.Muted)  Notes   : persistent PTY / Ctrl+C to stop$($Colors.Reset)"
  Write-Host "$($Colors.Accent)$line$($Colors.Reset)"
}

function Stop-ListeningProcesses {
  param([int]$Port)

  $stopped = [System.Collections.Generic.List[int]]::new()
  $listenerPids = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($listenerPid in $listenerPids) {
    if (-not $listenerPid -or $listenerPid -eq $PID) {
      continue
    }

    try {
      Stop-Process -Id $listenerPid -Force -ErrorAction Stop
      $stopped.Add($listenerPid)
    } catch {
    }
  }

  return $stopped.ToArray()
}

function Start-BrowserWaiter {
  param(
    [string]$HealthUrl,
    [string]$UiUrl
  )

  if ($SkipBrowser) {
    return
  }

  $waiterScript = @"
`$healthUrl = '$HealthUrl'
`$uiUrl = '$UiUrl'
for (`$i = 0; `$i -lt 120; `$i++) {
  try {
    `$response = Invoke-WebRequest -Uri `$healthUrl -UseBasicParsing -TimeoutSec 1
    if (`$response.StatusCode -eq 200) {
      Start-Process `$uiUrl
      break
    }
  } catch {
  }
  Start-Sleep -Milliseconds 750
}
"@

  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($waiterScript))
  $currentShellPath = (Get-Process -Id $PID).Path
  Start-Process -FilePath $currentShellPath -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-EncodedCommand",
    $encodedScript
  ) -WindowStyle Hidden | Out-Null
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$colors = Get-LauncherColors

try {
  Set-Location -LiteralPath $projectRoot

  $config = Read-LauncherConfig -ProjectRoot $projectRoot
  $baseUrl = "http://{0}:{1}" -f $config.Host, $config.Port
  $healthUrl = "$baseUrl/api/health"
  $uiNonce = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $uiUrl = "$baseUrl/multiCLI-discord-base.html?v=$uiNonce&launcher=shortcut"

  Restore-ConsoleWindow
  Set-LauncherTitle -Title "multiCLI-discord-base"
  Write-LauncherBanner -Colors $colors -ProjectRoot $projectRoot -BaseUrl $baseUrl -HealthUrl $healthUrl -UiUrl $uiUrl

  if ($DryRun) {
    Write-Host "$($colors.Ok)[launcher] dry run complete.$($colors.Reset)"
    exit 0
  }

  $stoppedPids = @(Stop-ListeningProcesses -Port $config.Port)
  if ($stoppedPids.Count -gt 0) {
    Write-Host "$($colors.Warn)[launcher] stopped existing listener PID(s): $($stoppedPids -join ', ')$($colors.Reset)"
  }

  Start-BrowserWaiter -HealthUrl $healthUrl -UiUrl $uiUrl
  Write-Host "$($colors.Ok)[launcher] opening browser after health check succeeds...$($colors.Reset)"

  $nodeArgs = @(
    "--env-file-if-exists=.env",
    "server/src/index.js"
  )

  $exitCode = 0
  while ($true) {
    Restore-ConsoleWindow
    Set-LauncherTitle -Title "multiCLI-discord-base"
    Write-Host ""
    Write-Host "$($colors.Accent)[server] node $($nodeArgs -join ' ')$($colors.Reset)"
    & node @nodeArgs
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }

    if ($exitCode -ne 42) {
      break
    }

    Write-Host ""
    Write-Host "$($colors.Warn)[restart] multiCLI-discord-base requested a restart. Waiting 3 seconds...$($colors.Reset)"
    Start-Sleep -Seconds 3
  }

  if ($exitCode -ne 0) {
    Wait-OnLauncherError -Message "server exited with code $exitCode" -Colors $colors
  }

  exit $exitCode
} catch {
  Restore-ConsoleWindow
  Set-LauncherTitle -Title "multiCLI-discord-base"
  Wait-OnLauncherError -Message $_.Exception.Message -Colors $colors
  exit 1
}
