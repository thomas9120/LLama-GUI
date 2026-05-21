param(
    [string]$InstallDir,
    [switch]$ShortcutsOnly
)

$ErrorActionPreference = "Stop"

function Resolve-LlamaGuiInstallDir {
    param([string]$RequestedDir)

    if ($RequestedDir) {
        return (Resolve-Path -LiteralPath $RequestedDir).Path
    }

    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Convert-ToSingleQuotedPowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Write-LauncherScript {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$LauncherPath
    )

    $rootLiteral = Convert-ToSingleQuotedPowerShellLiteral $RootDir
    $content = @"
`$ErrorActionPreference = "Stop"
`$rootDir = $rootLiteral
Set-Location -LiteralPath `$rootDir

function Show-LauncherError {
    param([Parameter(Mandatory = `$true)][string]`$Message)
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
    if ([type]::GetType("System.Windows.MessageBox")) {
        [System.Windows.MessageBox]::Show(`$Message, "Llama GUI", "OK", "Error") | Out-Null
    } else {
        Write-Host `$Message
        Read-Host "Press Enter to close"
    }
}

function Get-LlamaGuiPythonCommand {
    `$venvPython = Join-Path `$rootDir ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath `$venvPython) {
        return @{ File = `$venvPython; Args = @() }
    }

    `$python = Get-Command "python" -ErrorAction SilentlyContinue
    if (`$python) {
        return @{ File = `$python.Source; Args = @() }
    }

    `$py = Get-Command "py" -ErrorAction SilentlyContinue
    if (`$py) {
        return @{ File = `$py.Source; Args = @("-3") }
    }

    return `$null
}

function Convert-ToSingleQuotedPowerShellLiteral {
    param([Parameter(Mandatory = `$true)][string]`$Value)
    return "'" + (`$Value -replace "'", "''") + "'"
}

function Get-BrowserUrl {
    `$hostName = if (`$env:LLAMA_GUI_HOST) { `$env:LLAMA_GUI_HOST } else { "127.0.0.1" }
    `$port = if (`$env:LLAMA_GUI_PORT) { `$env:LLAMA_GUI_PORT } else { "5240" }

    `$browserHost = `$hostName
    if (`$browserHost -in @("0.0.0.0", "::", "*")) {
        `$browserHost = "127.0.0.1"
    }
    if (`$browserHost.StartsWith("[") -and `$browserHost.EndsWith("]")) {
        `$browserHost = `$browserHost.Substring(1, `$browserHost.Length - 2)
    }
    if (`$browserHost.Contains(":")) {
        `$browserHost = "[`$browserHost]"
    }

    return "http://`${browserHost}:`$port"
}

function Wait-ForLlamaGui {
    param(
        [Parameter(Mandatory = `$true)][string]`$Url,
        [int]`$TimeoutSeconds = 45
    )

    `$statusUrl = "`$Url/api/status"
    `$deadline = (Get-Date).AddSeconds(`$TimeoutSeconds)
    while ((Get-Date) -lt `$deadline) {
        try {
            Invoke-WebRequest -Uri `$statusUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
            return `$true
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }
    return `$false
}

`$url = Get-BrowserUrl
if (Wait-ForLlamaGui -Url `$url -TimeoutSeconds 2) {
    Start-Process `$url
    exit 0
}

`$python = Get-LlamaGuiPythonCommand
if (`$null -eq `$python) {
    Show-LauncherError "Python was not found. Run windows_install.bat first, or install Python 3.9+ and ensure it is available in PATH."
    exit 1
}

`$serverParts = @(`$python.File) + `$python.Args + @("server.py")
`$serverCommand = "& " + ((`$serverParts | ForEach-Object { Convert-ToSingleQuotedPowerShellLiteral `$_ }) -join " ")
Start-Process -FilePath "powershell.exe" -WorkingDirectory `$rootDir -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", `$serverCommand) | Out-Null

if (Wait-ForLlamaGui -Url `$url) {
    Start-Process `$url
    exit 0
}

Show-LauncherError "Llama GUI did not become reachable at `$url within 45 seconds. Check the server terminal for startup errors."
exit 1
"@

    New-Item -ItemType Directory -Path (Split-Path -Parent $LauncherPath) -Force | Out-Null
    Set-Content -LiteralPath $LauncherPath -Value $content -Encoding UTF8
}

function New-LlamaGuiShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [string]$IconPath
    )

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`""
    $shortcut.WorkingDirectory = $RootDir
    $shortcut.Description = "Start Llama GUI"
    if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
        $shortcut.IconLocation = "$IconPath,0"
    }
    $shortcut.Save()
}

$rootDir = Resolve-LlamaGuiInstallDir $InstallDir
$launcherPath = Join-Path $rootDir ".launcher\launch-llama-gui.ps1"
$iconPath = Join-Path $rootDir "assets\Llama-GUI.ico"
$desktopPath = [Environment]::GetFolderPath("Desktop")

if (-not (Test-Path -LiteralPath (Join-Path $rootDir "server.py"))) {
    throw "Install directory does not look like Llama GUI: $rootDir"
}

if ($ShortcutsOnly) {
    Write-Host "Regenerating Llama GUI shortcuts..."
} else {
    Write-Host "Creating Llama GUI desktop shortcut..."
}

Write-LauncherScript -RootDir $rootDir -LauncherPath $launcherPath

if (-not $desktopPath) {
    throw "Could not locate the current user's Desktop folder."
}

$shortcutPath = Join-Path $desktopPath "Llama GUI.lnk"
New-LlamaGuiShortcut -ShortcutPath $shortcutPath -RootDir $rootDir -LauncherPath $launcherPath -IconPath $iconPath

Write-Host "Shortcut ready: $shortcutPath"
