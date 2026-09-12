"""Checks that file references in the tracked docs point at real files.

Companion to ``test_docs_sync.py``: that file keeps the route table honest,
this one keeps file references honest. Both exist because documentation
drift is invisible to code — a reference to a deleted file renders exactly
like a live one, and the 2026-09 onboarding audit found nine of them.

Scope: every git-tracked Markdown file, i.e. the set CI actually sees.
Untracked local notes never run in CI, so scanning only tracked files
matches enforcement to reality. Two categories are skipped inside that set:

- ``docs/design-docs/`` — deliberately untracked local reference notes.
  The skip is by prefix and not existence-checked because a fresh clone
  does not contain the directory. References *into* the directory are
  likewise not existence-checked: those files live only on one machine,
  so CI could never verify them.
- ``EXEMPT_DOCS`` — archived implementation records that intentionally
  quote pre-rename files. Their entries are existence-checked, so
  deleting an exempted doc flags the stale entry here.

What counts as a reference (lines inside fenced code blocks are skipped;
examples in fences routinely name files that do not exist):

- Relative markdown links, e.g. ``[text](../AGENTS.md)``, resolved against
  the linking doc's directory. External URLs and same-page anchors are
  not file references.
- Backtick-quoted repo-rooted paths starting with ``docs/``, ``ui/``,
  ``backend/``, ``tests/``, or ``scripts/`` — e.g. `` `ui/js/app.js` ``.
  Runtime-created directories (``llama/``, ``models/``, ``presets/``,
  ``tools/``) are deliberately outside the prefix list: a fresh clone
  does not contain them.

llama.cpp's own ``tests/`` files collide with this repo's prefix and are
allowlisted via ``UPSTREAM_PATHS``; the allowlist is itself checked against
what the docs still reference, so it cannot silently rot.
"""

import re
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Local-only reference notes, never part of CI. Skipped by prefix (not
# existence-checked): a fresh clone does not contain this directory.
LOCAL_ONLY_DIRS = ("docs/design-docs/",)

# Deliberate exemptions. test_exempt_docs_exist asserts every entry still
# exists on disk, so deleting an exempted doc flags the stale entry.
EXEMPT_DOCS = {
    # Archived implementation record; intentionally references pre-rename
    # files like ui/js/chat-ui.js.
    "docs/frontend-module-split-plan.md",
    # Same, for the Tier-2 frontend split.
    "docs/frontend-maintainability-tier-2-plan.md",
    # Onboarding audit tracker; quotes dead paths and stale commands as
    # evidence. Remove this entry when the doc itself is removed.
    "docs/developer-onboarding-plan.md",
}

# llama.cpp's own files that collide with this repo's tests/ prefix. They
# are referenced by docs/upstream-changes.md fork notes, never by this
# repo. test_upstream_allowlist_is_current asserts each entry is still
# referenced somewhere, so removed mentions flag stale entries.
UPSTREAM_PATHS = {
    "tests/CMakeLists.txt",
    "tests/test-arg-parser.cpp",
    "tests/test-speculative-adaptive.cpp",
}

# Backtick-quoted, repo-rooted paths with a known prefix. Wildcards and
# placeholders (<name>, *.jinja) do not match this pattern.
BACKTICK_PATH_RE = re.compile(
    r"`((?:docs|ui|backend|tests|scripts)/[A-Za-z0-9_./-]+)`"
)

# Relative markdown links: [text](target) and ![alt](target).
MARKDOWN_LINK_RE = re.compile(r"\]\(([^)\s]+)\)")

# scheme:path targets (https:, mailto:, ...) are not file references.
EXTERNAL_TARGET_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")

# Docs that every scan must include; if discovery loses them, the other
# tests would pass vacuously.
CORE_DOCS = {
    "AGENTS.md",
    "README.md",
    "docs/directory.md",
    "docs/tests.md",
    "docs/upstream-changes.md",
}


def tracked_markdown_files() -> list:
    """The Markdown files git tracks — the set CI actually sees."""
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise AssertionError(
            "git ls-files failed, so the tracked doc set is unknown: "
            + (result.stderr.strip() or f"exit code {result.returncode}")
        )
    return [
        REPO_ROOT / name
        for name in result.stdout.split("\0")
        if name.endswith(".md")
    ]


def is_exempt(rel_path: str) -> bool:
    return rel_path in EXEMPT_DOCS or rel_path.startswith(LOCAL_ONLY_DIRS)


def dead_link(rel_path: str, lineno: int, target: str) -> str:
    """One failure line for a markdown link, or None if it is fine."""
    if target.startswith("#") or EXTERNAL_TARGET_RE.match(target):
        return None
    target = target.split("#", 1)[0]
    if not target:
        return None
    if ((REPO_ROOT / rel_path).parent / target).exists():
        return None
    return f"{rel_path}:{lineno}: link target does not exist: {target}"


class DocsReferenceTests(unittest.TestCase):
    def scan(self):
        """Collect (dead references, upstream paths seen) from live docs."""
        failures = []
        upstream_seen = set()
        for path in tracked_markdown_files():
            rel = path.relative_to(REPO_ROOT).as_posix()
            if is_exempt(rel):
                continue
            in_fence = False
            for lineno, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                if line.lstrip().startswith("```"):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                for target in MARKDOWN_LINK_RE.findall(line):
                    failure = dead_link(rel, lineno, target)
                    if failure:
                        failures.append(failure)
                for ref in BACKTICK_PATH_RE.findall(line):
                    if ref in UPSTREAM_PATHS:
                        upstream_seen.add(ref)
                    elif ref.startswith(LOCAL_ONLY_DIRS):
                        continue
                    elif not (REPO_ROOT / ref).exists():
                        failures.append(
                            f"{rel}:{lineno}: referenced path "
                            f"does not exist: {ref}"
                        )
        return failures, upstream_seen

    def test_doc_discovery_is_sane(self):
        rels = {
            path.relative_to(REPO_ROOT).as_posix()
            for path in tracked_markdown_files()
        }
        missing = CORE_DOCS - rels
        self.assertFalse(
            missing,
            "doc discovery lost core files: "
            f"{sorted(missing)}; without them the scan passes vacuously",
        )
        self.assertGreaterEqual(
            len(rels), 10, f"expected a double-digit doc set, got {len(rels)}"
        )

    def test_references_resolve(self):
        failures, _ = self.scan()
        self.assertFalse(
            failures,
            "docs reference missing files:\n" + "\n".join(failures),
        )

    def test_exempt_docs_exist(self):
        stale = sorted(
            rel for rel in EXEMPT_DOCS if not (REPO_ROOT / rel).exists()
        )
        self.assertFalse(
            stale,
            "EXEMPT_DOCS lists files that no longer exist; "
            f"remove the stale entries: {stale}",
        )

    def test_upstream_allowlist_is_current(self):
        _, upstream_seen = self.scan()
        self.assertEqual(
            UPSTREAM_PATHS,
            upstream_seen,
            "UPSTREAM_PATHS and the docs disagree; update the allowlist "
            f"(unreferenced entries: {sorted(UPSTREAM_PATHS - upstream_seen)},"
            f" unlisted references: {sorted(upstream_seen - UPSTREAM_PATHS)})",
        )


if __name__ == "__main__":
    unittest.main()
