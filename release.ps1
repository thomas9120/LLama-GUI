param(
    [string]$Root = $PSScriptRoot,
    [string]$Version = "dev-build"
)

$ErrorActionPreference = "Stop"

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentPath = Get-NormalizedFullPath $Parent
    $childPath = Get-NormalizedFullPath $Child
    $parentPrefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar

    if (-not $childPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside release directory: $childPath"
    }
}

$rootPath = Get-NormalizedFullPath $Root
$invalidVersionChars = [System.IO.Path]::GetInvalidFileNameChars()
if ($Version.IndexOfAny($invalidVersionChars) -ge 0) {
    throw "Version contains characters that cannot be used in a file name: $Version"
}

$packageName = "Llama-GUI-$Version"
$releasesDir = Join-Path $rootPath "releases"
$stageDir = Join-Path $releasesDir $packageName
$zipPath = Join-Path $releasesDir "$packageName.zip"

Write-Host "Building release package: $packageName"

New-Item -ItemType Directory -Path $releasesDir -Force | Out-Null
Assert-ChildPath -Parent $releasesDir -Child $stageDir
Assert-ChildPath -Parent $releasesDir -Child $zipPath

if (Test-Path $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stageDir | Out-Null

$items = @(
    "README.md",
    "LICENSE",
    "requirements.txt",
    "server.py",
    "install.sh",
    "mac_linux_start.sh",
    "mac_linux_silent_start.sh",
    "windows_install.bat",
    "windows_start.bat",
    "windows_startsilent.bat",
    "release.bat",
    "release.ps1",
    "ui"
)

foreach ($item in $items) {
    $source = Join-Path $rootPath $item
    if (-not (Test-Path $source)) {
        throw "Missing release item: $item"
    }
    Copy-Item -LiteralPath $source -Destination $stageDir -Recurse -Force
}

$placeholderDirs = @(
    "llama\bin",
    "llama\dll",
    "llama\grammars",
    "models",
    "presets"
)

foreach ($dir in $placeholderDirs) {
    $targetDir = Join-Path $stageDir $dir
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    $placeholder = Join-Path $targetDir ".gitkeep"
    if (-not (Test-Path $placeholder)) {
        New-Item -ItemType File -Path $placeholder | Out-Null
    }
}

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Release zip ready:"
Write-Host $zipPath
Write-Host ""
Write-Host "Upload this file to the GitHub release asset list."
