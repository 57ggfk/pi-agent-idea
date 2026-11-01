# IDE e2e harness for Windows (companion to scripts/e2e-ide.sh): launches
# runIde with the mock pi binary + JCEF CDP, waits for readiness, then drives
# the UI via scripts/e2e-ide.mjs. Usage from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1 [-Real]
param(
    # Run against the user's real pi instead of the mock binary.
    [switch]$Real,
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$repo = (Get-Location).Path

if ($Real) {
    $env:PI_IDE_E2E = "real"
} else {
    $env:PI_IDE_E2E = Join-Path $repo "test\mock-pi\mock-pi.mjs"
}
$env:PI_IDE_E2E_PROJECT = if ($env:PI_IDE_E2E_PROJECT) { $env:PI_IDE_E2E_PROJECT } else { Join-Path $repo "test\e2e-project" }

if (-not $env:JAVA_HOME) {
    $jdk = Get-ChildItem -Directory -ErrorAction SilentlyContinue @(
        "$env:ProgramFiles\Java\jdk-21*",
        "$env:USERPROFILE\.jdks\jdk-21*",
        "$env:LOCALAPPDATA\Programs\Java\jdk-21*"
    ) | Select-Object -First 1
    if ($jdk) { $env:JAVA_HOME = $jdk.FullName } else { Write-Warning "JAVA_HOME not set and no JDK 21 found" }
}

New-Item -ItemType Directory -Force -Path (Join-Path $repo "build") | Out-Null
$log = Join-Path $repo "build\runIde-e2e.log"
$gradle = Start-Process -FilePath (Join-Path $repo "gradlew.bat") `
    -ArgumentList "runIde", "--console=plain" `
    -WorkingDirectory $repo -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
    -PassThru -NoNewWindow

function Wait-HttpOk([string]$url, [int]$seconds) {
    for ($i = 0; $i -lt ($seconds / 3); $i++) {
        Start-Sleep -Seconds 3
        try {
            if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true }
        } catch { }
    }
    return $false
}

try {
    Write-Host "waiting for JCEF CDP on :9222 ..."
    [void](Wait-HttpOk "http://127.0.0.1:9222/json/version" 200)
    Write-Host "waiting for the Pi Agent page ..."
    [void](Wait-HttpOk "http://127.0.0.1:9222/json/list" 90)
    Start-Sleep -Seconds 5

    if ($Real) {
        node (Join-Path $repo "scripts\e2e-ide-real.mjs")
    } else {
        node (Join-Path $repo "scripts\e2e-ide.mjs") --screenshot (Join-Path $repo "build\e2e-ide.png")
    }
} finally {
    Stop-Process -Id $gradle.Id -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
        Where-Object { $_.CommandLine -match "idea.required.plugins.id=dev.pi.agent" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
