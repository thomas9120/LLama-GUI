"""Shared helpers for spawning short-lived child processes."""

import subprocess
import sys


def get_no_window_creationflags() -> int:
    """Return creation flags that keep helper subprocesses off-screen.

    On Windows a process started with ``DETACHED_PROCESS`` owns no console, so
    every console application it launches is given a brand-new console window.
    The restart flow in ``lifecycle`` detaches the replacement server, which is
    why the ``git`` and ``llama`` probes start flashing terminal windows only
    after the Restart Python Server button is used. ``CREATE_NO_WINDOW`` keeps
    those children hidden regardless of whether the parent has a console.

    This is only for short-lived probes whose output is captured. Long-running
    llama.cpp runtimes and the restart handoff set their own creation flags for
    process-group signalling and must not use this.

    Other platforms have no equivalent, so the flags are zero there.
    """
    if sys.platform != "win32":
        return 0
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)
