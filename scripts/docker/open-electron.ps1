# Start the local container, then open the installed Girru Electron app in its Docker profile.
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    $docker = (Get-Command docker.exe -ErrorAction SilentlyContinue).Source
    if (-not $docker) { $docker = Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe' }
    if (-not (Test-Path -LiteralPath $docker)) { throw 'Install or start Docker Desktop first.' }
    # Docker Desktop also resolves its credential helper through PATH.
    $env:Path = (Split-Path -Parent $docker) + ';' + $env:Path
    $app = @(
        (Join-Path $env:LOCALAPPDATA 'Programs/Dpro/Girru/Girru.exe')
        (Join-Path $env:LOCALAPPDATA 'Programs/Girru/Girru.exe')
        (Join-Path $env:ProgramFiles 'Girru/Girru.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $app) { throw 'Install Girru first, or start Compose and use File > Connect to an Existing Girru in your custom installation.' }
    & $docker compose up -d --build --wait
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose did not start Girru. Check docker compose logs backend.' }

    $profileDir = Join-Path $env:LOCALAPPDATA 'Girru/DockerProfile'
    [IO.Directory]::CreateDirectory($profileDir) | Out-Null
    [IO.File]::WriteAllText((Join-Path $profileDir 'desktop.json'), '{"mode":"remote","remoteUrl":"http://127.0.0.1:41522"}')
    $env:DPRO_DESKTOP_PROFILE_DIR = $profileDir
    $env:GIRRU_PROFILE_DIR = $profileDir
    $origin = 'http://127.0.0.1:41522'
    $status = Invoke-RestMethod "$origin/api/setup/status"
    Start-Process -FilePath $app
    if ($status.setupRequired) {
        Write-Host 'In Girru choose your workspace type, then paste the private setup link below. You can also open the link in a browser.'
        & $docker compose exec -T backend node /app/scripts/docker/setup.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the first-run link.' }
        Read-Host 'Press Enter to close this window after copying the link' | Out-Null
    }
} finally { Pop-Location }
