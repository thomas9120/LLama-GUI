$ErrorActionPreference = "Stop"

$repoUrl = if ($env:LLAMA_GUI_REPO_URL) { $env:LLAMA_GUI_REPO_URL } else { "https://github.com/thomas9120/LLama-GUI.git" }
$repoBranch = if ($env:LLAMA_GUI_BRANCH) { $env:LLAMA_GUI_BRANCH } else { "main" }
$installDir = if ($env:LLAMA_GUI_INSTALL_DIR) { $env:LLAMA_GUI_INSTALL_DIR } else { Join-Path $HOME "LLama-GUI" }

function Test-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
    }
}

function Get-PythonCommand {
    if (Test-Command "py") {
        return @{ File = "py"; Args = @("-3") }
    }
    if (Test-Command "python") {
        return @{ File = "python"; Args = @() }
    }
    return $null
}

if (-not (Test-Command "git")) {
    throw "Required command not found: git. Install Git for Windows and rerun this installer."
}

$python = Get-PythonCommand
if ($null -eq $python) {
    throw "Python 3 was not found. Install Python 3.9+ from https://www.python.org/downloads/ and ensure it is available in PATH."
}

if (Test-Path $installDir) {
    $gitDir = Join-Path $installDir ".git"
    if (-not (Test-Path $gitDir)) {
        throw "Install path already exists but is not a git checkout: $installDir. Set LLAMA_GUI_INSTALL_DIR to a different folder and rerun this installer."
    }

    Write-Host "Updating existing Llama GUI checkout at $installDir..."
    Invoke-Native "git" @("-C", $installDir, "pull", "--ff-only")
} else {
    Write-Host "Cloning Llama GUI into $installDir..."
    Invoke-Native "git" @("clone", "--branch", $repoBranch, $repoUrl, $installDir)
}

Set-Location $installDir

if (-not (Test-Path ".venv")) {
    Write-Host "Creating local virtual environment..."
    Invoke-Native $python.File ($python.Args + @("-m", "venv", ".venv"))
}

$venvPython = Join-Path $installDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Virtual environment is missing its Python executable. Delete .venv and rerun this installer."
}

Write-Host "Upgrading pip..."
Invoke-Native $venvPython @("-m", "pip", "install", "--upgrade", "pip")

Write-Host "Installing Python dependencies from requirements.txt..."
Invoke-Native $venvPython @("-m", "pip", "install", "-r", "requirements.txt")

if ($env:LLAMA_GUI_NO_START -eq "1") {
    Write-Host ""
    Write-Host "Install complete. Start Llama GUI later with:"
    Write-Host "  cd `"$installDir`"; .\windows_start.bat"
    exit 0
}

Write-Host ""
Write-Host "Starting Llama GUI..."
Invoke-Native "cmd.exe" @("/c", "windows_start.bat")
