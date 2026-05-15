"""Backend tests.

Unittest discovery with `-s tests` imports this directory as the top-level
`backend` package. Include the application backend package path so imports such
as `backend.config` still resolve during that discovery mode.
"""

from pathlib import Path


APP_BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
__path__.append(str(APP_BACKEND_DIR))

