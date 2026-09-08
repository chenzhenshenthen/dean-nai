param([switch]$SkipWebBuild)

$ErrorActionPreference = "Stop"

$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $launcherDir
$outputDir = Join-Path $root "desktop-dist"
$workDir = Join-Path $root "desktop-build"
$specDir = Join-Path $workDir "spec"
$rootExe = Join-Path $root "dean-nai.exe"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3 was not found in PATH."
}

python -c "import webview, PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Desktop build dependencies are missing. Run: python -m pip install -r desktop_launcher\requirements.txt"
}

if (-not $SkipWebBuild) {
    Push-Location (Join-Path $root "deanai")
    try {
        npm run build:desktop
        if ($LASTEXITCODE -ne 0) {
            throw "deanai desktop web build failed."
        }
    }
    finally {
        Pop-Location
    }
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
New-Item -ItemType Directory -Path $specDir -Force | Out-Null

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "dean-nai" `
    --distpath $outputDir `
    --workpath $workDir `
    --specpath $specDir `
    (Join-Path $launcherDir "launcher.py")

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed."
}

$exe = Join-Path $outputDir "dean-nai.exe"
Copy-Item -LiteralPath $exe -Destination $rootExe -Force
Write-Host ""
Write-Host "dean-nai desktop app built successfully:" -ForegroundColor Green
Write-Host $rootExe -ForegroundColor Cyan
Write-Host "This EXE starts its own single local service; start-local.bat is a separate legacy launch method."
