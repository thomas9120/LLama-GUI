@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PY_LAUNCHER="
set "PY_ARGS="
set "VENV_PYTHON=%CD%\.venv\Scripts\python.exe"

where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PY_LAUNCHER=py"
    set "PY_ARGS=-3"
) else (
    where python >nul 2>&1
    if %ERRORLEVEL% EQU 0 set "PY_LAUNCHER=python"
)

if not defined PY_LAUNCHER (
    echo [ERROR] Python 3 was not found on this system.
    echo.
    echo Install Python 3.9+ and ensure it is available in PATH.
    echo Download: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

if not exist ".venv" (
    echo Creating local virtual environment...
    call %PY_LAUNCHER% %PY_ARGS% -m venv .venv
    if errorlevel 1 goto :install_error
)

if not exist "%VENV_PYTHON%" (
    echo [ERROR] Virtual environment is missing its Python executable.
    echo Delete ".venv" and rerun this installer.
    echo.
    pause
    exit /b 1
)

echo Upgrading pip...
call "%VENV_PYTHON%" -m pip install --upgrade pip
if errorlevel 1 goto :install_error

echo Installing Python dependencies from requirements.txt...
call "%VENV_PYTHON%" -m pip install -r requirements.txt
if errorlevel 1 goto :install_error

echo.
echo Install complete.
echo Start the app with windows_start.bat or windows_startsilent.bat
echo.
pause
exit /b 0

:install_error
echo.
echo [ERROR] Dependency installation failed.
echo Review the error output above and rerun this script after fixing the issue.
echo.
pause
exit /b 1
