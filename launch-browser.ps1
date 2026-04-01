$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $projectRoot ".env"
$port = 3087
$hostName = "127.0.0.1"

if (Test-Path $envPath) {
  foreach ($line in Get-Content $envPath) {
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

    if ($key -eq "PORT") {
      $parsedPort = 0
      if ([int]::TryParse($value, [ref]$parsedPort)) {
        $port = $parsedPort
      }
    }

    if ($key -eq "HOST" -and $value) {
      $hostName = $value
    }
  }
}

$baseUrl = "http://{0}:{1}" -f $hostName, $port
$healthUrl = "$baseUrl/api/health"

function Test-CoDiCoDiHealth {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-CoDiCoDiHealth -Url $healthUrl)) {
  Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @(
      "/k",
      "cd /d ""$projectRoot"" && call scripts\start-server.cmd"
    ) `
    -WorkingDirectory $projectRoot

  $started = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-CoDiCoDiHealth -Url $healthUrl) {
      $started = $true
      break
    }
  }

  if (-not $started) {
    throw "CoDiCoDi server did not become ready: $healthUrl"
  }
}

Start-Process $baseUrl
