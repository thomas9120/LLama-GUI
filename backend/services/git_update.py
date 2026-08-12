"""Git-based app update helpers."""

import os
import re
import subprocess
import sys
from typing import Any

from ..context import AppContext
from .subprocess_utils import get_no_window_creationflags


# Ceiling for any single git invocation. Generous enough for a cold `fetch` over
# a slow link, short enough that a wedged command cannot pin an HTTP thread.
GIT_COMMAND_TIMEOUT_SECONDS = 120

# Passed to `git for-each-ref` to skip tags that are obviously not releases
# (for example "Summer-2026") before they reach the regex below.
RELEASE_TAG_GLOB = "refs/tags/v[0-9]*"

# A release is "v<major>.<minor>.<patch>" with an optional single-letter revision
# suffix, so "v1.6.3" and the follow-up "v1.6.3b" both count. Anything carrying a
# prerelease marker ("v1.6.3-rc1", "v1.6.3-beta", "v1.7.0-pre") is excluded: those
# must never be handed to users as an automatic update.
RELEASE_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+[a-z]?$")

UPDATE_CHANNELS = {"stable", "nightly"}

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
    ".env",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
}

# Filename prefixes (as opposed to the directory prefixes above), for families
# of local files like ".env.local". Keep these specific enough that they cannot
# swallow unrelated neighbours: ".env." must not be loosened to ".env", which
# would also match ".envrc".
SAFE_DIRTY_FILE_PREFIXES = (".env.",)

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
    if any(path.startswith(prefix) for prefix in SAFE_DIRTY_FILE_PREFIXES):
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


def run_git(args, cwd, timeout=GIT_COMMAND_TIMEOUT_SECONDS):
    # Runs on an HTTP handler thread, so it must never block indefinitely. A
    # network git command (fetch/ls-remote) against a repo needing credentials
    # would otherwise sit forever on a prompt: stdin is closed and
    # GIT_TERMINAL_PROMPT=0 turns the ask into an error, the timeout catches
    # anything that still stalls, and GIT_ASKPASS/SSH_ASKPASS stop a GUI
    # credential helper from popping up where nobody can answer it.
    env = dict(os.environ)
    env.update({
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "SSH_ASKPASS": "",
        "GCM_INTERACTIVE": "Never",
    })
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            check=False,
            stdin=subprocess.DEVNULL,
            timeout=timeout,
            env=env,
            creationflags=get_no_window_creationflags(),
        )
    except subprocess.TimeoutExpired as exc:
        print(f"[git_update] git {' '.join(args)} timed out after {timeout}s", file=sys.stderr)
        # Shaped like a failed CompletedProcess so every caller's returncode
        # check keeps working instead of needing a new exception path.
        return subprocess.CompletedProcess(
            args=["git", *args],
            returncode=124,
            stdout=exc.stdout if isinstance(exc.stdout, str) else "",
            stderr=f"git {args[0] if args else ''} timed out after {timeout} seconds.",
        )


def remote_ref_exists(base_dir, remote_ref):
    result = run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/{remote_ref}"],
        base_dir,
    )
    return result.returncode == 0


def is_release_tag(tag):
    return bool(RELEASE_TAG_RE.match(str(tag or "").strip()))


def normalize_update_channel(value):
    channel = str(value or "stable").strip().lower()
    if channel not in UPDATE_CHANNELS:
        raise ValueError("Update channel must be 'stable' or 'nightly'.")
    return channel


def find_latest_release_tag(base_dir, upstream_ref):
    """Return the newest release tag reachable from ``upstream_ref``.

    Tags are sorted with git's version sort rather than by date: these are
    lightweight tags, so a date sort really compares commit dates, which puts a
    hotfix tagged onto an older commit in the wrong place. Version sort orders
    ``v1.6.3 < v1.6.3b < v1.6.4 < v1.6.10`` as intended.
    """
    result = run_git(
        [
            "for-each-ref",
            f"--merged={upstream_ref}",
            "--sort=-v:refname",
            "--format=%(refname:short)",
            RELEASE_TAG_GLOB,
        ],
        base_dir,
    )
    if result.returncode != 0:
        return {
            "tag": "",
            "error": (result.stderr or "Unable to inspect release tags").strip(),
        }

    # The glob keeps out non-version tags such as "Summer-2026"; the regex is
    # what rejects prereleases ("v1.6.3-rc1"), which the glob still matches.
    for line in result.stdout.splitlines():
        tag = line.strip()
        if is_release_tag(tag):
            return {"tag": tag, "error": ""}
    return {"tag": "", "error": ""}


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
        creationflags=get_no_window_creationflags(),
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
        creationflags=get_no_window_creationflags(),
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


def unavailable_status(reason, repo_url, update_channel):
    return {
        "available": False,
        "can_update": False,
        "state": "error",
        "reason": reason,
        "repo_url": repo_url,
        "update_channel": update_channel,
    }


def error_status(reason, **fields):
    """Status for a git failure the user has to resolve manually.

    Every non-final return path carries ``state`` so the frontend can key off it
    and surface ``reason``; without it the UI falls through to a generic message
    and the actual git error is lost.
    """
    return {
        "available": True,
        "can_update": False,
        "state": "error",
        "reason": reason,
        **fields,
    }


def get_app_update_status(
    ctx: AppContext,
    fetch: bool = False,
    channel: str = "stable",
) -> dict[str, Any]:
    base_dir = ctx.paths.root
    repo_url = ctx.config.app_repo_url
    update_channel = normalize_update_channel(channel)

    if not (base_dir / ".git").exists():
        return unavailable_status(
            "This folder is not a git repository.", repo_url, update_channel
        )

    git_version = run_git(["--version"], base_dir)
    if git_version.returncode != 0:
        return unavailable_status(
            "Git is not available on this system.", repo_url, update_channel
        )

    branch_res = run_git(["rev-parse", "--abbrev-ref", "HEAD"], base_dir)
    if branch_res.returncode != 0:
        return error_status(
            (branch_res.stderr or "Unable to read current git branch").strip(),
            repo_url=repo_url,
            update_channel=update_channel,
        )
    branch = branch_res.stdout.strip()

    # Stable tags and nightly commits come from one configured branch. Using the
    # checked-out branch instead would pin a development checkout to its own
    # stale tags or commits.
    release_branch = (ctx.config.app_release_branch or "").strip() or branch
    upstream_ref = f"origin/{release_branch}"

    remote_res = run_git(["config", "--get", "remote.origin.url"], base_dir)
    origin_url = remote_res.stdout.strip() if remote_res.returncode == 0 else ""

    common = {
        "repo_url": repo_url,
        "origin_url": origin_url,
        "branch": branch,
        "release_branch": release_branch,
        "update_channel": update_channel,
    }

    dirty_res = run_git(["status", "--porcelain=v1", "-z"], base_dir)
    if dirty_res.returncode != 0:
        return error_status(
            (dirty_res.stderr or "Unable to inspect git status").strip(),
            **common,
        )
    dirty_entries = parse_git_status_porcelain_z(dirty_res.stdout)
    dirty_info = classify_git_dirty_paths(dirty_entries)
    has_local_changes = bool(dirty_info["dirty_paths"])
    has_blocking_changes = bool(dirty_info["blocking_dirty_paths"])
    common = {
        **common,
        "dirty": has_local_changes,
        "has_blocking_changes": has_blocking_changes,
        **dirty_info,
    }

    if fetch:
        # --prune-tags is what actually drops tags deleted upstream; --prune on
        # its own only prunes remote-tracking branches, which would leave a
        # withdrawn release sitting locally as the newest tag.
        fetch_res = run_git(
            ["fetch", "origin", "--prune", "--prune-tags", "--tags"],
            base_dir,
        )
        if fetch_res.returncode != 0:
            return error_status(
                (fetch_res.stderr or "Failed to fetch from origin").strip(),
                **common,
            )

    # Checked explicitly: `for-each-ref --merged=<missing ref>` fails with a raw
    # "fatal: malformed object name" that means nothing to a user.
    if not remote_ref_exists(base_dir, upstream_ref):
        return error_status(
            f"No upstream branch found at {upstream_ref}.",
            **common,
        )

    release_tag = ""
    target_ref = upstream_ref
    if update_channel == "stable":
        release_info = find_latest_release_tag(base_dir, upstream_ref)
        if release_info["error"]:
            return error_status(release_info["error"], **common)

        release_tag = release_info["tag"]
        if not release_tag:
            return {
                "available": True,
                "can_update": False,
                "reason": f"No tagged release was found on {upstream_ref}.",
                **common,
                "ahead": 0,
                "behind": 0,
                "state": "no_release",
                "release_tag": "",
                "target_ref": "",
            }
        target_ref = f"refs/tags/{release_tag}"

    behind_ahead_res = run_git(
        ["rev-list", "--left-right", "--count", f"HEAD...{target_ref}"],
        base_dir,
    )
    if behind_ahead_res.returncode != 0:
        target_name = f"release {release_tag}" if release_tag else target_ref
        return error_status(
            f"Unable to compare HEAD with {target_name}.",
            **common,
            release_tag=release_tag,
            target_ref=target_ref,
        )

    parts = behind_ahead_res.stdout.strip().split()
    ahead = int(parts[0]) if len(parts) > 0 else 0
    behind = int(parts[1]) if len(parts) > 1 else 0

    # "behind" means the selected target is a strict descendant of HEAD, which
    # is exactly the condition under which `merge --ff-only` can succeed.
    if behind > 0 and ahead > 0:
        state = "diverged"
    elif behind > 0:
        state = "behind"
    else:
        state = "up_to_date"

    can_update = state == "behind" and not has_blocking_changes

    return {
        "available": True,
        "can_update": can_update,
        **common,
        "ahead": ahead,
        "behind": behind,
        "state": state,
        "release_tag": release_tag,
        "target_ref": target_ref,
    }


def update_app_from_git(ctx: AppContext, channel: str = "stable") -> dict[str, Any]:
    base_dir = ctx.paths.root
    update_channel = normalize_update_channel(channel)
    status = get_app_update_status(ctx, fetch=True, channel=update_channel)
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
        if state == "diverged":
            return {
                "updated": False,
                "error": "Branch has diverged from the selected update target; manual merge/rebase required.",
                "status": status,
            }
        return {
            "updated": False,
            "error": status.get("reason", "App cannot be updated automatically."),
            "status": status,
        }

    release_tag = status.get("release_tag", "")
    target_ref = status["target_ref"]
    update_res = run_git(
        ["merge", "--ff-only", target_ref],
        base_dir,
    )
    if update_res.returncode != 0:
        return {
            "updated": False,
            "error": (
                update_res.stderr or update_res.stdout or "git merge failed"
            ).strip(),
            "status": get_app_update_status(ctx, fetch=False, channel=update_channel),
        }

    deps_res = install_python_dependencies(ctx)
    target_name = release_tag or target_ref
    if deps_res.get("error"):
        shortcuts_res = create_windows_shortcuts(ctx)
        return {
            "updated": True,
            "dependencies_installed": False,
            "dependency_error": deps_res["error"],
            "shortcuts_created": shortcuts_res.get("created", False),
            "shortcuts_error": shortcuts_res.get("error", ""),
            "shortcuts_message": shortcuts_res.get("message", ""),
            "release_tag": release_tag,
            "update_channel": update_channel,
            "message": (update_res.stdout or f"Updated to {target_name}").strip(),
            "status": get_app_update_status(ctx, fetch=False, channel=update_channel),
        }

    shortcuts_res = create_windows_shortcuts(ctx)
    return {
        "updated": True,
        "dependencies_installed": deps_res.get("installed", False),
        "dependency_message": deps_res.get("message", ""),
        "shortcuts_created": shortcuts_res.get("created", False),
        "shortcuts_error": shortcuts_res.get("error", ""),
        "shortcuts_message": shortcuts_res.get("message", ""),
        "release_tag": release_tag,
        "update_channel": update_channel,
        "message": (update_res.stdout or f"Updated to {target_name}").strip(),
        "status": get_app_update_status(ctx, fetch=False, channel=update_channel),
    }
