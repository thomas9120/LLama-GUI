"""Git-based app update helpers."""

import subprocess
import sys
from typing import Any

from ..context import AppContext


SAFE_DIRTY_PATH_PREFIXES = (
    "llama/",
    "models/",
    "presets/",
    "releases/",
    "__pycache__/",
    ".ruff_cache/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".venv/",
    "venv/",
    "env/",
    "logs/",
    "tmp/",
    "temp/",
)

SAFE_DIRTY_PATHS = {
    "config.json",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
}

SAFE_DIRTY_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".log",
    ".tmp",
    ".temp",
    ".bak",
    ".orig",
    ".swp",
    ".swo",
    ".zip",
    ".tar.gz",
    ".tgz",
)


def normalize_git_path(path):
    return str(path or "").replace("\\", "/").strip()


def parse_git_status_porcelain_z(output):
    entries = []
    parts = output.split("\0")
    i = 0
    while i < len(parts):
        raw = parts[i]
        i += 1
        if not raw:
            continue

        status = raw[:2]
        path = normalize_git_path(raw[3:])
        if not path:
            continue

        entries.append({"status": status, "path": path})

        if status[0] in {"R", "C"} or status[1] in {"R", "C"}:
            if i < len(parts) and parts[i]:
                entries[-1]["source_path"] = normalize_git_path(parts[i])
                i += 1

    return entries


def is_safe_dirty_path(path):
    path = normalize_git_path(path)
    if not path:
        return False
    if path in SAFE_DIRTY_PATHS:
        return True
    if path.startswith(".env"):
        return True
    if any(path.startswith(prefix) for prefix in SAFE_DIRTY_PATH_PREFIXES):
        return True
    return any(path.endswith(suffix) for suffix in SAFE_DIRTY_SUFFIXES)


def classify_git_dirty_paths(entries):
    safe = []
    blocking = []

    for entry in entries:
        path = entry.get("path", "")
        source_path = entry.get("source_path", "")
        path_is_safe = is_safe_dirty_path(path)
        source_is_safe = not source_path or is_safe_dirty_path(source_path)
        target = safe if path_is_safe and source_is_safe else blocking
        target.append(entry)

    return {
        "dirty_paths": [entry["path"] for entry in entries],
        "safe_dirty_paths": [entry["path"] for entry in safe],
        "blocking_dirty_paths": [entry["path"] for entry in blocking],
        "dirty_entries": entries,
    }


def run_git(args, cwd):
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )


def install_python_dependencies(ctx: AppContext) -> dict[str, Any]:
    requirements_path = ctx.paths.root / "requirements.txt"
    if not requirements_path.exists():
        return {"installed": False, "message": "requirements.txt was not found."}

    res = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(requirements_path)],
        cwd=str(ctx.paths.root),
        capture_output=True,
        text=True,
        check=False,
    )
    output = (res.stdout or res.stderr or "").strip()
    if res.returncode != 0:
        return {
            "installed": False,
            "error": (res.stderr or res.stdout or "Dependency installation failed.").strip(),
        }
    return {
        "installed": True,
        "message": output.splitlines()[-1] if output else "Dependencies are up to date.",
    }


def create_windows_shortcuts(ctx: AppContext) -> dict[str, Any]:
    if sys.platform != "win32":
        return {"created": False, "skipped": True, "message": "Desktop shortcuts are Windows-only."}

    shortcut_script = ctx.paths.root / "scripts" / "create_windows_shortcuts.ps1"
    if not shortcut_script.exists():
        return {"created": False, "skipped": True, "message": "Shortcut helper was not found."}

    res = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(shortcut_script),
            "-InstallDir",
            str(ctx.paths.root),
            "-ShortcutsOnly",
        ],
        cwd=str(ctx.paths.root),
        capture_output=True,
        text=True,
        check=False,
    )
    output = (res.stdout or res.stderr or "").strip()
    if res.returncode != 0:
        return {
            "created": False,
            "error": (res.stderr or res.stdout or "Desktop shortcut creation failed.").strip(),
        }
    return {
        "created": True,
        "message": output.splitlines()[-1] if output else "Desktop shortcut created.",
    }


def get_app_update_status(ctx: AppContext, fetch: bool = False) -> dict[str, Any]:
    base_dir = ctx.paths.root
    repo_url = ctx.config.app_repo_url

    if not (base_dir / ".git").exists():
        return {
            "available": False,
            "can_update": False,
            "reason": "This folder is not a git repository.",
            "repo_url": repo_url,
        }

    git_version = run_git(["--version"], base_dir)
    if git_version.returncode != 0:
        return {
            "available": False,
            "can_update": False,
            "reason": "Git is not available on this system.",
            "repo_url": repo_url,
        }

    branch_res = run_git(["rev-parse", "--abbrev-ref", "HEAD"], base_dir)
    if branch_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": (
                branch_res.stderr or "Unable to read current git branch"
            ).strip(),
            "repo_url": repo_url,
        }
    branch = branch_res.stdout.strip()

    remote_res = run_git(["config", "--get", "remote.origin.url"], base_dir)
    origin_url = remote_res.stdout.strip() if remote_res.returncode == 0 else ""

    dirty_res = run_git(["status", "--porcelain=v1", "-z"], base_dir)
    if dirty_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": (dirty_res.stderr or "Unable to inspect git status").strip(),
            "repo_url": repo_url,
            "origin_url": origin_url,
            "branch": branch,
        }
    dirty_entries = parse_git_status_porcelain_z(dirty_res.stdout)
    dirty_info = classify_git_dirty_paths(dirty_entries)
    has_local_changes = bool(dirty_info["dirty_paths"])
    has_blocking_changes = bool(dirty_info["blocking_dirty_paths"])

    if fetch:
        fetch_res = run_git(["fetch", "origin", "--prune"], base_dir)
        if fetch_res.returncode != 0:
            return {
                "available": True,
                "can_update": False,
                "reason": (fetch_res.stderr or "Failed to fetch from origin").strip(),
                "repo_url": repo_url,
                "origin_url": origin_url,
                "branch": branch,
                "dirty": has_local_changes,
                "has_blocking_changes": has_blocking_changes,
                **dirty_info,
            }

    upstream_ref = f"origin/{branch}"
    behind_ahead_res = run_git(
        ["rev-list", "--left-right", "--count", f"HEAD...{upstream_ref}"],
        base_dir,
    )
    if behind_ahead_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": f"No upstream branch found at {upstream_ref}.",
            "repo_url": repo_url,
            "origin_url": origin_url,
            "branch": branch,
            "dirty": has_local_changes,
            "has_blocking_changes": has_blocking_changes,
            **dirty_info,
        }

    parts = behind_ahead_res.stdout.strip().split()
    ahead = int(parts[0]) if len(parts) > 0 else 0
    behind = int(parts[1]) if len(parts) > 1 else 0

    if ahead > 0 and behind > 0:
        state = "diverged"
    elif ahead > 0:
        state = "ahead"
    elif behind > 0:
        state = "behind"
    else:
        state = "up_to_date"

    can_update = state == "behind" and not has_blocking_changes

    return {
        "available": True,
        "can_update": can_update,
        "repo_url": repo_url,
        "origin_url": origin_url,
        "branch": branch,
        "dirty": has_local_changes,
        "has_blocking_changes": has_blocking_changes,
        **dirty_info,
        "ahead": ahead,
        "behind": behind,
        "state": state,
    }


def update_app_from_git(ctx: AppContext) -> dict[str, Any]:
    base_dir = ctx.paths.root
    status = get_app_update_status(ctx, fetch=True)
    if not status.get("available"):
        return {
            "updated": False,
            "error": status.get("reason", "App update is unavailable"),
            "status": status,
        }

    if not status.get("can_update"):
        state = status.get("state")
        if state == "up_to_date":
            return {"updated": False, "status": status, "message": "Already up to date"}
        if status.get("has_blocking_changes"):
            paths = status.get("blocking_dirty_paths") or []
            detail = f" Blocking paths: {', '.join(paths[:8])}" if paths else ""
            return {
                "updated": False,
                "error": "Cannot auto-update with source changes. Commit or stash first." + detail,
                "status": status,
            }
        if state == "ahead":
            return {
                "updated": False,
                "error": "Local branch is ahead of origin; not pulling automatically.",
                "status": status,
            }
        if state == "diverged":
            return {
                "updated": False,
                "error": "Branch has diverged from origin; manual merge/rebase required.",
                "status": status,
            }
        return {
            "updated": False,
            "error": status.get("reason", "App cannot be updated automatically."),
            "status": status,
        }

    pull_res = run_git(["pull", "--ff-only", "origin", status["branch"]], base_dir)
    if pull_res.returncode != 0:
        return {
            "updated": False,
            "error": (pull_res.stderr or pull_res.stdout or "git pull failed").strip(),
            "status": get_app_update_status(ctx, fetch=False),
        }

    deps_res = install_python_dependencies(ctx)
    if deps_res.get("error"):
        shortcuts_res = create_windows_shortcuts(ctx)
        return {
            "updated": True,
            "dependencies_installed": False,
            "dependency_error": deps_res["error"],
            "shortcuts_created": shortcuts_res.get("created", False),
            "shortcuts_error": shortcuts_res.get("error", ""),
            "shortcuts_message": shortcuts_res.get("message", ""),
            "message": (pull_res.stdout or "Updated successfully").strip(),
            "status": get_app_update_status(ctx, fetch=False),
        }

    shortcuts_res = create_windows_shortcuts(ctx)
    return {
        "updated": True,
        "dependencies_installed": deps_res.get("installed", False),
        "dependency_message": deps_res.get("message", ""),
        "shortcuts_created": shortcuts_res.get("created", False),
        "shortcuts_error": shortcuts_res.get("error", ""),
        "shortcuts_message": shortcuts_res.get("message", ""),
        "message": (pull_res.stdout or "Updated successfully").strip(),
        "status": get_app_update_status(ctx, fetch=False),
    }
