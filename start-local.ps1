$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$libraryDir = Join-Path $root "nai-artist-library"
$studioDir = Join-Path $root "deanai"

$dayStamp = Get-Date -Format "yyyy-MM-dd"
$runId = "{0}-{1}" -f (Get-Date -Format "HHmmss-fff"), $PID
$logRoot = Join-Path $root "logs"
$sessionLogDir = Join-Path $logRoot $dayStamp
$runtimeRoot = Join-Path $root ".runtime"
$runtimeDir = Join-Path $runtimeRoot $runId
$launcherLog = Join-Path $sessionLogDir "launcher.log"
$libraryLog = Join-Path $sessionLogDir "nai-artist-library.log"
$studioLog = Join-Path $sessionLogDir "dean-nai-web.log"
$libraryExitFile = Join-Path $runtimeDir "nai-artist-library.exit-code"
$studioExitFile = Join-Path $runtimeDir "dean-nai-web.exit-code"
$libraryJobPidFile = Join-Path $runtimeDir "nai-artist-library.job-pid"
$studioJobPidFile = Join-Path $runtimeDir "dean-nai-web.job-pid"

New-Item -ItemType Directory -Path $sessionLogDir -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $logRoot "latest-session.txt") -Value $sessionLogDir -Encoding UTF8

$retentionDays = 30
try {
    $settingsPath = Join-Path $libraryDir "data\integrated-settings.json"
    if (Test-Path -LiteralPath $settingsPath) {
        $savedRetention = (Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json).log_retention_days
        if ($savedRetention) { $retentionDays = [Math]::Min(3650, [Math]::Max(1, [int]$savedRetention)) }
    }
} catch {}
if ($env:DEAN_NAI_LOG_RETENTION_DAYS) {
    $parsedRetention = 0
    if ([int]::TryParse($env:DEAN_NAI_LOG_RETENTION_DAYS, [ref]$parsedRetention)) {
        $retentionDays = [Math]::Min(3650, [Math]::Max(1, $parsedRetention))
    }
}
$resolvedLogRoot = [IO.Path]::GetFullPath($logRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
Get-ChildItem -LiteralPath $logRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-$retentionDays) } |
    ForEach-Object {
        if ([IO.Path]::GetFullPath($_.Parent.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar) -eq $resolvedLogRoot) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

function Write-LauncherLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Color = "Gray"
    )
    $line = "[{0}] [run:{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $Message
    Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
    Write-Host $Message -ForegroundColor $Color
}

function Show-ServiceLogTail {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Path
    )
    Write-Host ""
    Write-Host "----- $Label (last 80 lines) -----" -ForegroundColor DarkCyan
    if (Test-Path -LiteralPath $Path) {
        Get-Content -LiteralPath $Path -Tail 80 -ErrorAction Continue | ForEach-Object { Write-Host $_ }
    } else {
        Write-Host "No log file was created." -ForegroundColor Yellow
    }
}

function Read-ExitCode {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path) {
        return (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
    }
    return "not recorded"
}

function Stop-JobProcessTree {
    param([Parameter(Mandatory = $true)][string]$JobPidPath)
    if (-not (Test-Path -LiteralPath $JobPidPath)) { return }
    $jobProcessId = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $JobPidPath -Raw).Trim(), [ref]$jobProcessId)) { return }

    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $parents = @($jobProcessId)
    $descendants = @()
    do {
        $children = @($all | Where-Object { $parents -contains [int]$_.ParentProcessId -and $descendants -notcontains [int]$_.ProcessId })
        if (-not $children.Count) { break }
        $childIds = @($children | ForEach-Object { [int]$_.ProcessId })
        $descendants += $childIds
        $parents = $childIds
    } while ($true)

    [array]::Reverse($descendants)
    foreach ($processId in $descendants) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3 was not found in PATH."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or newer was not found in PATH."
}
if (-not (Test-Path -LiteralPath (Join-Path $studioDir "node_modules"))) {
    Write-LauncherLog "Installing deanai packages for the first run..." "Cyan"
    Push-Location $studioDir
    try { & npm.cmd install } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

Write-LauncherLog "Log session: $sessionLogDir" "DarkGray"
Write-LauncherLog "Starting the local prompt library on http://127.0.0.1:5179" "Cyan"
$libraryJob = Start-Job -Name "nai-artist-library" -ScriptBlock {
    param($dir, $logPath, $exitPath, $jobPidPath, $runId)
    $ErrorActionPreference = "Continue"
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Set-Location -LiteralPath $dir
    $env:NAI_LIBRARY_NO_BROWSER = "1"
    Set-Content -LiteralPath $jobPidPath -Value $PID -Encoding ASCII
    Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] [launcher] starting: python app.py" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId) -Encoding UTF8
    try {
        & python app.py 2>&1 | ForEach-Object {
            Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $_.ToString()) -Encoding UTF8
        }
        $exitCode = $LASTEXITCODE
        Set-Content -LiteralPath $exitPath -Value $exitCode -Encoding ASCII
        Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] [launcher] process exited with code {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $exitCode) -Encoding UTF8
        if ($exitCode -ne 0) { throw "nai-artist-library exited with code $exitCode" }
    } catch {
        if (-not (Test-Path -LiteralPath $exitPath)) { Set-Content -LiteralPath $exitPath -Value "1" -Encoding ASCII }
        Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] [launcher] fatal: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $_.Exception.Message) -Encoding UTF8
        throw
    }
} -ArgumentList $libraryDir, $libraryLog, $libraryExitFile, $libraryJobPidFile, $runId

Write-LauncherLog "Starting the local deanai studio on http://127.0.0.1:3000" "Cyan"
$studioJob = Start-Job -Name "dean-nai-web" -ScriptBlock {
    param($dir, $logPath, $exitPath, $jobPidPath, $runId)
    $ErrorActionPreference = "Continue"
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $env:NO_COLOR = "1"
    $env:FORCE_COLOR = "0"
    Set-Location -LiteralPath $dir
    Set-Content -LiteralPath $jobPidPath -Value $PID -Encoding ASCII
    Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] [launcher] starting: npm run dev -- --hostname 127.0.0.1" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId) -Encoding UTF8
    try {
        & npm.cmd run dev -- --hostname 127.0.0.1 2>&1 | ForEach-Object {
            Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $_.ToString()) -Encoding UTF8
        }
        $exitCode = $LASTEXITCODE
        Set-Content -LiteralPath $exitPath -Value $exitCode -Encoding ASCII
        Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] [launcher] process exited with code {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $exitCode) -Encoding UTF8
        if ($exitCode -ne 0) { throw "deanai exited with code $exitCode" }
    } catch {
        if (-not (Test-Path -LiteralPath $exitPath)) { Set-Content -LiteralPath $exitPath -Value "1" -Encoding ASCII }
        Add-Content -LiteralPath $logPath -Value ("[{0}] [run:{1}] [launcher] fatal: {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $runId, $_.Exception.Message) -Encoding UTF8
        throw
    }
} -ArgumentList $studioDir, $studioLog, $studioExitFile, $studioJobPidFile, $runId

try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000" -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        if ($studioJob.State -ne "Running" -or $libraryJob.State -ne "Running") { break }
    }

    if (-not $ready) {
        $summary = "Startup failed. Library state=$($libraryJob.State), exit=$(Read-ExitCode $libraryExitFile); deanai state=$($studioJob.State), exit=$(Read-ExitCode $studioExitFile)."
        Write-LauncherLog $summary "Red"
        Show-ServiceLogTail "nai-artist-library" $libraryLog
        Show-ServiceLogTail "deanai" $studioLog
        throw "Startup failed. Full logs: $sessionLogDir"
    }

    if ($env:NAI_LOCAL_NO_BROWSER -ne "1") {
        Start-Process "http://127.0.0.1:3000"
    }
    Write-Host ""
    Write-LauncherLog "Ready. Close this window or press Ctrl+C to stop both local services." "Green"
    Write-LauncherLog "Logs are being written to: $sessionLogDir" "DarkGray"
    if ($env:NAI_LOCAL_SMOKE_TEST -eq "1") {
        Write-LauncherLog "Smoke test reached ready state; shutting down cleanly." "DarkGray"
        return
    }
    while ($libraryJob.State -eq "Running" -and $studioJob.State -eq "Running") {
        Start-Sleep -Seconds 2
    }

    $summary = "A service stopped unexpectedly. Library state=$($libraryJob.State), exit=$(Read-ExitCode $libraryExitFile); deanai state=$($studioJob.State), exit=$(Read-ExitCode $studioExitFile)."
    Write-LauncherLog $summary "Yellow"
    Show-ServiceLogTail "nai-artist-library" $libraryLog
    Show-ServiceLogTail "deanai" $studioLog
    throw "A local service stopped. Full logs: $sessionLogDir"
} finally {
    Write-LauncherLog "Stopping local services. Library state=$($libraryJob.State); deanai state=$($studioJob.State)." "DarkGray"
    Stop-JobProcessTree $libraryJobPidFile
    Stop-JobProcessTree $studioJobPidFile
    Stop-Job $libraryJob, $studioJob -ErrorAction SilentlyContinue
    Remove-Job $libraryJob, $studioJob -Force -ErrorAction SilentlyContinue
    Write-LauncherLog "Launcher finished. Logs retained at: $sessionLogDir" "DarkGray"
    $resolvedRuntimeRoot = [IO.Path]::GetFullPath($runtimeRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $resolvedRuntimeDir = [IO.Path]::GetFullPath($runtimeDir)
    if ($resolvedRuntimeDir.StartsWith($resolvedRuntimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
