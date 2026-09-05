"""Create per-user Linux/macOS launchers without additional dependencies."""

import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys


BUNDLE_ID = "io.github.thomas9120.llama-gui.launcher"


def write_text(path, content, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(content)
    if executable:
        path.chmod(0o755)


def desktop_value(value):
    """Escape the desktop-entry string layer (also applied to Exec)."""
    return (str(value).replace("\\", "\\\\").replace("\n", "\\n")
            .replace("\r", "\\r").replace("\t", "\\t"))


def desktop_argument(value):
    # Exec has its own quoting layer, decoded after desktop-entry escapes.
    value = str(value).replace("%", "%%")
    for char in ('\\', '"', '`', '$'):
        value = value.replace(char, "\\" + char)
    return desktop_value('"' + value + '"')


def linux_desktop(home):
    if shutil.which("xdg-user-dir"):
        result = subprocess.run(
            ["xdg-user-dir", "DESKTOP"], capture_output=True, text=True,
            check=True, timeout=10,
        )
        desktop = Path(result.stdout.strip())
    else:
        desktop = home / "Desktop"
    # XDG uses $HOME to indicate a disabled desktop directory.
    if desktop.is_absolute() and desktop.is_dir() and desktop.resolve() != home.resolve():
        return desktop
    return None


def create_linux_shortcuts(root, home):
    data_home = Path(os.environ.get("XDG_DATA_HOME") or home / ".local/share")
    if not data_home.is_absolute():
        data_home = home / ".local/share"
    content = (
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Llama GUI\n"
        "Comment=Start Llama GUI in your browser\n"
        f"Exec=/bin/sh {desktop_argument(root / 'mac_linux_silent_start.sh')}\n"
        f"Path={desktop_value(root)}\n"
        f"Icon={desktop_value(root / 'assets/Llama-GUI.png')}\n"
        "Terminal=false\nCategories=Development;\nStartupNotify=false\n"
    )
    application = data_home / "applications/llama-gui.desktop"
    write_text(application, content)
    print(f"Applications launcher ready: {application}")
    desktop = linux_desktop(home)
    if desktop:
        shortcut = desktop / "llama-gui.desktop"
        write_text(shortcut, content, executable=True)
        print(f"Desktop shortcut ready: {shortcut}")
        print("Your desktop may require right-click > Allow Launching before first use.")
    else:
        print("No desktop directory enabled; use the applications menu launcher.")


def create_macos_shortcuts(root, home):
    application = home / "Applications/Llama GUI.app"
    contents = application / "Contents"
    info = contents / "Info.plist"
    if application.exists():
        # Do not replace an unrelated app with the same display name.
        with info.open("rb") as stream:
            if plistlib.load(stream).get("CFBundleIdentifier") != BUNDLE_ID:
                raise ValueError(f"An unrelated application already exists at {application}")
    # Identify our bundle first so reruns can repair an interrupted install.
    contents.mkdir(parents=True, exist_ok=True)
    with info.open("wb") as stream:
        plistlib.dump({
            "CFBundleIdentifier": BUNDLE_ID,
            "CFBundleName": "Llama GUI",
            "CFBundleDisplayName": "Llama GUI",
            "CFBundleExecutable": "llama-gui",
            "CFBundlePackageType": "APPL",
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleVersion": "1",
            "CFBundleIconFile": "Llama-GUI.icns",
            "LSUIElement": True,
        }, stream)
    executable = contents / "MacOS/llama-gui"
    write_text(executable,
               "#!/bin/sh\nexec /bin/sh "
               + shlex.quote(str(root / "mac_linux_silent_start.sh")) + "\n",
               executable=True)
    resources = contents / "Resources"
    resources.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / "assets/Llama-GUI.icns", resources / "Llama-GUI.icns")
    print(f"Application launcher ready: {application}")
    desktop = home / "Desktop"
    if desktop.is_dir():
        shortcut = desktop / "Llama GUI.app"
        if shortcut.is_symlink() and shortcut.resolve() == application.resolve():
            return
        if shortcut.exists() or shortcut.is_symlink():
            raise FileExistsError(f"Desktop item already exists; left untouched: {shortcut}")
        shortcut.symlink_to(application, target_is_directory=True)
        print(f"Desktop shortcut ready: {shortcut}")


def main():
    if sys.platform not in ("linux", "darwin"):
        print("Shortcut creation skipped: this helper supports Linux and macOS.")
        return 0
    root = Path(__file__).resolve().parent.parent
    try:
        if not (root / "mac_linux_silent_start.sh").is_file():
            raise FileNotFoundError("The silent-start script was not found.")
        create = create_linux_shortcuts if sys.platform == "linux" else create_macos_shortcuts
        create(root, Path.home())
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError) as error:
        print(f"[WARNING] Shortcut creation could not finish: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
