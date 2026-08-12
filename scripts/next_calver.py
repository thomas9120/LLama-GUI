"""Print the next UTC YY.MM.Micro version from this repository's tags."""

from __future__ import annotations

import re
import subprocess
from datetime import date, datetime, timezone
from typing import Iterable, Optional


def next_calver(tags: Iterable[str], today: Optional[date] = None) -> str:
    today = today or datetime.now(timezone.utc).date()
    prefix = today.strftime("%y.%m")
    pattern = re.compile(rf"^v{re.escape(prefix)}\.(\d+)$")
    micros = [int(match.group(1)) for tag in tags if (match := pattern.fullmatch(tag.strip()))]
    return f"{prefix}.{max(micros, default=-1) + 1}"


if __name__ == "__main__":
    result = subprocess.run(
        ["git", "tag", "--list"],
        check=True,
        capture_output=True,
        text=True,
    )
    print(next_calver(result.stdout.splitlines()))
