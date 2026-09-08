param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Version,
    [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"

$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $launcherDir
$backendDir = Join-Path $root "nai-artist-library"
$webDir = Join-Path $root "deanai\desktop-web-dist"
$buildDir = Join-Path $root "desktop-build"
$backendDist = Join-Path $buildDir "backend-dist"
$backendWork = Join-Path $buildDir "backend-work"
$backendSpec = Join-Path $buildDir "backend-spec"
$releaseDir = Join-Path $root "release-dist"
$packageName = "dean-nai-$Version-windows-x64"
$stageDir = Join-Path $releaseDir $packageName
$zipPath = Join-Path $releaseDir "$packageName.zip"
$hashPath = "$zipPath.sha256"

$resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedRelease = [IO.Path]::GetFullPath($releaseDir)
if (-not $resolvedRelease.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release directory escaped the project root: $resolvedRelease"
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3 was not found in PATH."
}
python -c "import flask, PIL, docx, certifi, Crypto, webview, PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Release dependencies are missing. Install both requirements files first."
}

if (-not $SkipWebBuild) {
    Push-Location (Join-Path $root "deanai")
    try {
        npm run build:desktop
        if ($LASTEXITCODE -ne 0) { throw "dean-nai desktop web build failed." }
    }
    finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $webDir "index.html"))) {
    throw "Desktop web files are missing: $webDir"
}

foreach ($directory in @($backendDist, $backendWork, $backendSpec, $releaseDir)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "dean-nai-backend" `
    --paths $backendDir `
    --add-data "$(Join-Path $backendDir 'static');static" `
    --distpath $backendDist `
    --workpath $backendWork `
    --specpath $backendSpec `
    (Join-Path $backendDir "app.py")
if ($LASTEXITCODE -ne 0) { throw "Bundled backend build failed." }

& (Join-Path $launcherDir "build-desktop.ps1") -SkipWebBuild
if ($LASTEXITCODE -ne 0) { throw "Desktop launcher build failed." }

if (Test-Path -LiteralPath $stageDir) {
    $resolvedStage = [IO.Path]::GetFullPath($stageDir)
    if (-not $resolvedStage.StartsWith($resolvedRelease + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Staging directory escaped release-dist: $resolvedStage"
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stageDir "deanai") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "nai-artist-library") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $root "dean-nai.exe") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $backendDist "dean-nai-backend.exe") -Destination (Join-Path $stageDir "nai-artist-library")
Copy-Item -LiteralPath $webDir -Destination (Join-Path $stageDir "deanai\desktop-web-dist") -Recurse
Copy-Item -LiteralPath (Join-Path $launcherDir "RELEASE_README.txt") -Destination (Join-Path $stageDir "README.txt")
Copy-Item -LiteralPath (Join-Path $root "LICENSES.md") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $root "THIRD_PARTY_NOTICES.md") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $root "deanai\LICENSE") -Destination (Join-Path $stageDir "deanai")

foreach ($output in @($zipPath, $hashPath)) {
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
}
Compress-Archive -LiteralPath $stageDir -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
Set-Content -LiteralPath $hashPath -Value "$hash  $([IO.Path]::GetFileName($zipPath))" -Encoding Ascii

Write-Host ""
Write-Host "Windows release package built successfully:" -ForegroundColor Green
Write-Host $zipPath -ForegroundColor Cyan
Write-Host $hashPath -ForegroundColor Cyan
