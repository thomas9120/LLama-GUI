@echo off
setlocal
cd /d "%~dp0"

set "PY_CMD="
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PY_CMD=python"
) else (
    where py >nul 2>&1
    if %ERRORLEVEL% EQU 0 set "PY_CMD=py -3"
)

if not defined PY_CMD (
    echo [ERROR] Python was not found on this system.
    echo.
    echo Install Python 3 and ensure it is available in PATH.
    echo Download: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

start "Llama GUI Server" /min cmd /c "%PY_CMD% server.py"
exit /b 0
