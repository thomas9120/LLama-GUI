# Bug Tracker

Known bugs and issues that don't affect core functionality but should be addressed.

---

## Fixed 2026-07-24: terminal windows flashing after Restart Python Server

**Symptom:** after using Restart Python Server, every page refresh briefly popped a Windows
Terminal window.

**Cause:** the restart spawns the replacement server with `DETACHED_PROCESS`
(`backend/services/lifecycle.py`), so the new server owns no console. On Windows a console-less
process that launches a console application gets a brand-new console window for the child. Page
load calls the app-update status check, which runs six `git` subprocesses via `run_git()`, so six
console windows were created and destroyed. The same gap existed for the llama.cpp probes in
`process_manager.py` (buffer discovery and memory estimate) but was less visible because the
memory estimate bails out when no model is selected.

**Fix:** `backend/services/subprocess_utils.get_no_window_creationflags()` returns
`CREATE_NO_WINDOW` on Windows and `0` elsewhere, applied to the short-lived probe subprocesses in
`git_update.py` and `process_manager.py`. The long-running `Popen` calls in `lifecycle.py`,
`process_manager.py`, and `tunnel.py` were deliberately left alone; they set their own creation
flags for process-group signalling that stop/restart depends on.

**Verified:** with a detached, console-less parent, spawning a console app without the flag
creates a visible `CASCADIA_HOSTING_WINDOW_CLASS` window (Windows Terminal); with the flag, no
new visible window appears. Confirmed against the real `/api/app-update-status` route.

Note for future debugging: Windows 11 hosts new consoles in Windows Terminal, so window-class
checks must look for `CASCADIA_HOSTING_WINDOW_CLASS`, not just the legacy `ConsoleWindowClass`.
Counting `conhost.exe` processes is *not* a valid signal — `CREATE_NO_WINDOW` still creates a
console object hosted by conhost, just without a visible window.

## Fixed 2026-07-24: appReload parameter stuck in the address bar

`reloadAppWithCacheBust()` appends `appReload=<timestamp>` to force a fresh load after a restart,
but nothing removed it, so it persisted through every later refresh. No code ever read the value.
`clearAppReloadParam()` in `ui/js/manager.js` now strips it via `history.replaceState()` once
startup finishes, preserving any other query parameters (notably the `?preset=` deep link) and
the hash.

---

