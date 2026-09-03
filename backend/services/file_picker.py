"""Native file picker helpers."""

from pathlib import Path
import json
import platform
import subprocess
import sys
from typing import Any, Optional, Sequence, Tuple

from backend.context import AppContext
from backend.services import model_dir

FileTypes = Sequence[Tuple[str, str]]


class NativePickerUnavailableError(RuntimeError):
    """The platform-native picker cannot start because its GUI runtime is missing."""


def _native_picker_unavailable_message() -> str:
    if platform.system() == "Linux":
        return (
            "Native file picker unavailable because Python cannot load Tk. "
            "Install it with your system package manager "
            "(Arch/CachyOS: sudo pacman -S tk; Debian/Ubuntu: sudo apt install python3-tk), "
            "then restart Llama GUI."
        )
    return (
        "Native file picker unavailable because this Python installation cannot load Tcl/Tk. "
        "Repair or reinstall Python with Tcl/Tk support, then restart Llama GUI."
    )


def _create_tk_root():
    try:
        import tkinter as tk
        from tkinter import filedialog

        return tk.Tk(), filedialog
    except Exception as exc:
        print(
            f"[file_picker] native picker unavailable: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        raise NativePickerUnavailableError(_native_picker_unavailable_message()) from exc


def _extensions_from_filetypes(filetypes: Optional[FileTypes]) -> list[str]:
    extensions: list[str] = []
    seen = set()
    for _label, pattern_group in filetypes or []:
        for pattern in str(pattern_group or "").split():
            if not pattern.startswith("*."):
                continue
            ext = pattern[2:].strip().lower()
            if not ext or ext == "*" or ext in seen:
                continue
            seen.add(ext)
            extensions.append(ext)
    return extensions


def _applescript_list(values: Sequence[str]) -> str:
    return "{" + ", ".join(json.dumps(value) for value in values) + "}"


def select_file_with_osascript(
    title: str = "Select File",
    initial_dir: Optional[Path] = None,
    filetypes: Optional[FileTypes] = None,
) -> str:
    initial = Path(initial_dir or Path.home()).expanduser()
    extensions = _extensions_from_filetypes(filetypes)
    type_clause = ""
    if extensions:
        type_clause = f" of type {_applescript_list(extensions)}"

    script = (
        "set dialogTitle to item 1 of argv\n"
        "set initialDir to item 2 of argv\n"
        "try\n"
        "    set selectedFile to choose file with prompt dialogTitle "
        "default location (POSIX file initialDir)"
        f"{type_clause}\n"
        "    return POSIX path of selectedFile\n"
        "on error number -128\n"
        "    return \"__CANCEL__\"\n"
        "end try\n"
    )
    result = subprocess.run(
        ["osascript", "-e", f"on run argv\n{script}end run", str(title), str(initial)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode == 0 and result.stdout.strip() == "__CANCEL__":
        return ""
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "macOS file picker failed.").strip()
        raise RuntimeError(message)
    return result.stdout.strip()


def select_file_in_native_dialog(
    title: str = "Select File",
    initial_dir: Optional[Path] = None,
    filetypes: Optional[FileTypes] = None,
) -> str:
    if platform.system() == "Darwin":
        return select_file_with_osascript(title, initial_dir, filetypes)

    root, filedialog = _create_tk_root()
    try:
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception as exc:
            print(f"[file_picker] failed to set dialog topmost: {exc}", file=sys.stderr)

        dialog_options: dict[str, Any] = {"title": title, "parent": root}
        if initial_dir:
            dialog_options["initialdir"] = str(initial_dir)
        if filetypes:
            dialog_options["filetypes"] = filetypes

        root.update()
        selected = filedialog.askopenfilename(**dialog_options)
        return selected or ""
    finally:
        root.destroy()


def select_folder_with_osascript(
    title: str = "Select Folder",
    initial_dir: Optional[Path] = None,
) -> str:
    initial = Path(initial_dir or Path.home()).expanduser()
    script = (
        "set dialogTitle to item 1 of argv\n"
        "set initialDir to item 2 of argv\n"
        "try\n"
        "    set selectedFolder to choose folder with prompt dialogTitle "
        "default location (POSIX file initialDir)\n"
        "    return POSIX path of selectedFolder\n"
        "on error number -128\n"
        "    return \"__CANCEL__\"\n"
        "end try\n"
    )
    result = subprocess.run(
        ["osascript", "-e", f"on run argv\n{script}end run", str(title), str(initial)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode == 0 and result.stdout.strip() == "__CANCEL__":
        return ""
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "macOS folder picker failed.").strip()
        raise RuntimeError(message)
    return result.stdout.strip().rstrip("/") or "/"


def select_folder_in_native_dialog(
    title: str = "Select Folder",
    initial_dir: Optional[Path] = None,
) -> str:
    if platform.system() == "Darwin":
        return select_folder_with_osascript(title, initial_dir)

    root, filedialog = _create_tk_root()
    try:
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception as exc:
            print(f"[file_picker] failed to set dialog topmost: {exc}", file=sys.stderr)

        options: dict[str, Any] = {"title": title, "parent": root, "mustexist": True}
        if initial_dir:
            options["initialdir"] = str(initial_dir)
        root.update()
        return filedialog.askdirectory(**options) or ""
    finally:
        root.destroy()


# `purpose` is the flag id (see getPathPickerRequest in ui/js/app.js). "model" has
# no path flag today - the main model is a dropdown over models/ - but it is kept
# here so a future model path flag gets the models/ folder and filter by default.
MODEL_FILE_PURPOSES = frozenset({"model", "model_draft", "mmproj"})


def get_select_file_options(ctx: AppContext, purpose: Any, title: Any) -> tuple[str, Path, FileTypes]:
    normalized_purpose = str(purpose or "").strip().lower()
    normalized_title = str(title or "Select File").strip() or "Select File"

    is_model_file = normalized_purpose in MODEL_FILE_PURPOSES
    initial_dir = model_dir.get_models_dir(ctx) if is_model_file else ctx.paths.root

    filetypes: FileTypes = [("All files", "*.*")]
    if is_model_file:
        # GGUF only, matching every other model path check in the app: llama.cpp
        # dropped the legacy ggml .bin formats, and validate_hf_filename and the
        # UI's normalizeModelRelPath both reject .bin. "All files" stays as the
        # escape hatch for anything unusual.
        filetypes = [
            ("GGUF files", "*.gguf"),
            ("All files", "*.*"),
        ]

    return normalized_title, initial_dir, filetypes
