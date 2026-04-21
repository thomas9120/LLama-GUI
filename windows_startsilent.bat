@echo off
setlocal
cd /d "%~dp0"
set "APP_URL=http://127.0.0.1:5240"

set "PY_CMD="
if exist ".venv\Scripts\python.exe" (
    set "PY_CMD=.venv\Scripts\python.exe"
) else (
    where python >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        set "PY_CMD=python"
    ) else (
        where py >nul 2>&1
        if %ERRORLEVEL% EQU 0 set "PY_CMD=py -3"
    )
)

if not defined PY_CMD (
    echo [ERROR] Python was not found on this system.
    echo.
    echo Run windows_install.bat first, or install Python 3 and ensure it is available in PATH.
    echo Download: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

start "" "%APP_URL%" >nul 2>&1
start "Llama GUI Server" /min cmd /c "%PY_CMD% server.py"
exit /b 0
