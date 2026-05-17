@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "APP_HOST=%LLAMA_GUI_HOST%"
if not defined APP_HOST set "APP_HOST=127.0.0.1"
set "APP_PORT=%LLAMA_GUI_PORT%"
if not defined APP_PORT set "APP_PORT=5240"

set "APP_BROWSER_HOST=%APP_HOST%"
if "%APP_BROWSER_HOST%"=="0.0.0.0" set "APP_BROWSER_HOST=127.0.0.1"
if "%APP_BROWSER_HOST%"=="::" set "APP_BROWSER_HOST=127.0.0.1"
if "%APP_BROWSER_HOST%"=="*" set "APP_BROWSER_HOST=127.0.0.1"
if "%APP_BROWSER_HOST:~0,1%"=="[" if "%APP_BROWSER_HOST:~-1%"=="]" (
    set "APP_BROWSER_HOST=%APP_BROWSER_HOST:~1,-1%"
)
set "APP_URL_HOST=%APP_BROWSER_HOST%"
if not "!APP_URL_HOST::=!"=="!APP_URL_HOST!" set "APP_URL_HOST=[!APP_URL_HOST!]"
set "APP_URL=http://!APP_URL_HOST!:%APP_PORT%"

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
