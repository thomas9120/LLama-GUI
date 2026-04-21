@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "VERSION=%~1"
if "%VERSION%"=="" set "VERSION=dev-build"

set "PACKAGE_NAME=Llama-GUI-%VERSION%"
set "RELEASES_DIR=%ROOT%\releases"
set "STAGE_DIR=%RELEASES_DIR%\%PACKAGE_NAME%"
set "ZIP_PATH=%RELEASES_DIR%\%PACKAGE_NAME%.zip"

echo Building release package: %PACKAGE_NAME%

if not exist "%RELEASES_DIR%" mkdir "%RELEASES_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$root = [System.IO.Path]::GetFullPath('%ROOT%');" ^
    "$stageDir = [System.IO.Path]::GetFullPath('%STAGE_DIR%');" ^
    "$zipPath = [System.IO.Path]::GetFullPath('%ZIP_PATH%');" ^
    "$packageName = '%PACKAGE_NAME%';" ^
"$items = @('README.md','LICENSE','requirements.txt','server.py','install.sh','mac_linux_start.sh','mac_linux_silent_start.sh','windows_install.bat','windows_start.bat','windows_startsilent.bat','ui');" ^
    "if (Test-Path $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force; }" ^
    "if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force; }" ^
    "New-Item -ItemType Directory -Path $stageDir | Out-Null;" ^
    "foreach ($item in $items) {" ^
    "  $source = Join-Path $root $item;" ^
    "  if (-not (Test-Path $source)) { throw ('Missing release item: ' + $item); }" ^
    "  Copy-Item -LiteralPath $source -Destination $stageDir -Recurse -Force;" ^
    "}" ^
    "$placeholderDirs = @('llama\\bin','llama\\dll','llama\\grammars','models','presets');" ^
    "foreach ($dir in $placeholderDirs) {" ^
    "  $targetDir = Join-Path $stageDir $dir;" ^
    "  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null;" ^
    "  $placeholder = Join-Path $targetDir '.gitkeep';" ^
    "  if (-not (Test-Path $placeholder)) { New-Item -ItemType File -Path $placeholder | Out-Null; }" ^
    "}" ^
    "Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -CompressionLevel Optimal;" ^
    "Write-Host ('Created ' + $zipPath);"

if errorlevel 1 (
    echo Release build failed.
    exit /b 1
)

echo.
echo Release zip ready:
echo %ZIP_PATH%
echo.
echo Upload this file to the GitHub release asset list.
exit /b 0
