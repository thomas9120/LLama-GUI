"""Active model-directory validation and persistence."""

import os
from pathlib import Path
from typing import Any, Mapping

from backend.context import AppContext


class ModelsDirBusyError(RuntimeError):
    """Raised when the model root cannot change during a download."""


def _directory_error(path: Path) -> str:
    try:
        if not path.exists():
            return f"Models folder does not exist: {path}"
        if not path.is_dir():
            return f"Models folder is not a directory: {path}"
        with os.scandir(path):
            pass
    except (OSError, ValueError):
        return f"Models folder is unavailable or unreadable: {path}"
    return ""


def get_models_dir_info(ctx: AppContext) -> dict[str, Any]:
    """Return frontend-safe metadata for the configured model root."""
    config_data = dict(ctx.services.load_config())
    configured = config_data.get("models_dir")
    if configured is None or (isinstance(configured, str) and not configured.strip()):
        path = ctx.paths.models
        # The repository default is application-managed and may be created on
        # first use. Only a conflicting file or unreadable existing directory
        # makes it unavailable; custom paths are never created this way.
        error = _directory_error(path) if path.exists() else ""
        return {
            "models_dir": str(path),
            "models_arg_root": "models",
            "models_dir_is_default": True,
            "models_dir_available": not error,
            "models_dir_error": error,
        }

    if not isinstance(configured, str):
        return {
            "models_dir": str(configured),
            "models_arg_root": "",
            "models_dir_is_default": False,
            "models_dir_available": False,
            "models_dir_error": "Configured models folder is invalid.",
        }

    path = Path(configured)
    if not path.is_absolute():
        return {
            "models_dir": configured,
            "models_arg_root": "",
            "models_dir_is_default": False,
            "models_dir_available": False,
            "models_dir_error": "Configured models folder must be an absolute path.",
        }

    error = _directory_error(path)
    return {
        "models_dir": str(path),
        "models_arg_root": str(path) if not error else "",
        "models_dir_is_default": False,
        "models_dir_available": not error,
        "models_dir_error": error,
    }


def get_models_dir(ctx: AppContext) -> Path:
    """Return the usable active model root, never a silent fallback."""
    info = get_models_dir_info(ctx)
    if not info["models_dir_available"]:
        raise ValueError(info["models_dir_error"] or "Models folder is unavailable.")
    path = Path(info["models_dir"])
    if info["models_dir_is_default"] and not path.exists():
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"Models folder is unavailable or unreadable: {path}") from exc
    return path


def set_models_dir(ctx: AppContext, value: Any) -> Mapping[str, Any]:
    """Persist an existing absolute directory, or reset to the app default."""
    reset = value is None or (isinstance(value, str) and not value.strip())
    if not reset and not isinstance(value, str):
        raise ValueError("Models folder path must be an absolute path or null.")

    with ctx.state.model_download_lock:
        if ctx.state.model_download_in_progress:
            raise ModelsDirBusyError("Wait for the active model download to finish.")

        resolved = None
        if not reset:
            if "\x00" in value:
                raise ValueError("Models folder path is invalid.")
            candidate = Path(value).expanduser()
            if not candidate.is_absolute():
                raise ValueError("Models folder path must be absolute.")
            try:
                resolved = candidate.resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                raise ValueError(f"Models folder does not exist or is unavailable: {candidate}") from exc
            error = _directory_error(resolved)
            if error:
                raise ValueError(error)

        # Lock order is model_download_lock -> config_lock everywhere that
        # changes the active root, matching the download claim path.
        with ctx.state.config_lock:
            config_data = dict(ctx.services.load_config())
            if resolved is None:
                config_data.pop("models_dir", None)
            else:
                config_data["models_dir"] = str(resolved)
            ctx.services.save_config(config_data)

    return get_models_dir_info(ctx)
