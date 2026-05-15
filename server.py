"""Compatibility entrypoint for the Llama GUI backend.

The application implementation lives in backend.app. Keep this wrapper so
existing launchers, shortcuts, and tests that import or execute server.py keep
working while the backend package owns the real startup code.
"""

import sys
import types

import backend.app as _app
from backend.app import *  # noqa: F401,F403


class _ServerModule(types.ModuleType):
    def __setattr__(self, name, value):
        if hasattr(_app, name):
            setattr(_app, name, value)
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _ServerModule


if __name__ == "__main__":
    main()
