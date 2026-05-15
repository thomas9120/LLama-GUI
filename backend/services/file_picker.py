"""Native file picker helpers."""

from pathlib import Path
from typing import Any, Optional, Sequence, Tuple

from backend.context import AppContext

FileTypes = Sequence[Tuple[str, str]]


def select_file_in_native_dialog(
    title: str = "Select File",
    initial_dir: Optional[Path] = None,
    filetypes: Optional[FileTypes] = None,
) -> str:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise RuntimeError(f"Native file picker unavailable: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    dialog_options: dict[str, Any] = {"title": title, "parent": root}
    if initial_dir:
        dialog_options["initialdir"] = str(initial_dir)
    if filetypes:
        dialog_options["filetypes"] = filetypes

    try:
        root.update()
        selected = filedialog.askopenfilename(**dialog_options)
        return selected or ""
    finally:
        root.destroy()


def get_select_file_options(ctx: AppContext, purpose: Any, title: Any) -> tuple[str, Path, FileTypes]:
    normalized_purpose = str(purpose or "").strip().lower()
    normalized_title = str(title or "Select File").strip() or "Select File"

    initial_dir = (
        ctx.paths.models
        if normalized_purpose in {"model", "model_draft", "mmproj", "model_vocoder"}
        else ctx.paths.root
    )

    filetypes: FileTypes = [("All files", "*.*")]
    if normalized_purpose in {"model", "model_draft", "mmproj", "model_vocoder"}:
        filetypes = [
            ("Model files", "*.gguf *.bin"),
            ("GGUF files", "*.gguf"),
            ("BIN files", "*.bin"),
            ("All files", "*.*"),
        ]

    return normalized_title, initial_dir, filetypes
