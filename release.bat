@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "VERSION=%~1"
if "%VERSION%"=="" set "VERSION=dev-build"

set "RELEASE_SCRIPT=%ROOT%\release.ps1"
if not exist "%RELEASE_SCRIPT%" (
    echo Missing release script:
    echo %RELEASE_SCRIPT%
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%RELEASE_SCRIPT%" -Root "%ROOT%" -Version "%VERSION%"
if errorlevel 1 (
    echo Release build failed.
    exit /b 1
)

exit /b 0
