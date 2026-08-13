## Update 08-12-2026 — Necessity review

**Verdict: the plan is well-researched but not necessary. It is a hygiene
exercise, not a fix — nothing in the codebase is broken, and the triage below
shows none of the findings is a real bug.**

Re-verified facts: no ruff config anywhere, CI floor is py3.9 with no lint
job, zero `from __future__ import annotations`, and `sanitize_error` matches
the BLE001 "intentional" claim exactly.

**Baseline drift:** the 174-finding baseline is stale — a re-run on this date
reports **221 findings** (+47: more BLE001, SIM117, UP045, UP035, PIE807, plus
2 intentional B018s), and the projected post-config count is **~89**, not 67.
All drift is style; still zero correctness findings. If implementation ever
proceeds, Steps 2–4 must be re-derived from a fresh baseline (the per-finding
triage of the singles remains valid).

### Recommendations

1. **Do only Step 1 — the `ruff.toml`.** It is the only part that prevents
   actual harm: a bare `ruff check . --fix` under Ruff 0.16 defaults would let
   UP045 rewrite `Optional[X]` → `X | None`, a runtime SyntaxError on the
   py3.9 CI floor. The config defuses that landmine in ~15 lines and
   documents the error-handling policy. Cheap; adopt when convenient.
2. **Skip the bulk cleanup (Steps 2–4) unless the deferred CI lint job ships
   with it.** ~90% of the fixes are cosmetics (import sorting churn across
   17+ files, `typing` → `collections.abc`, `lambda: []` → `list`, `with`
   merging, PEP 585 annotations). Without a CI gate the zero-finding state
   decays at the next commit — the 174→221 drift above is the proof. The
   cleanup alone is one-time polish that rots.
3. **If lint value is ever wanted, adopt B904** (`raise ... from` inside
   `except`) — the only finding in this document with genuine debugging
   value. Currently deferred.

**Bottom line:** keep this log, adopt the config when convenient, and treat
the cleanup as something to pair with a CI lint job — not as standalone work.

---

## Ruff Baseline Cleanup

Deferred lint-maintenance task. A repository-wide `ruff check .` with Ruff 0.16.0 on 2026-07-25 reported 174 findings, 107 of which Ruff marked fixable with the default `--fix` behavior. This is a point-in-time baseline and will drift as the code changes.

- Add an explicit Ruff configuration (`pyproject.toml`, `ruff.toml`, or `.ruff.toml`) before applying bulk fixes. Set the target to Python 3.9 so modernization rules cannot produce syntax that breaks the oldest supported CI runtime.
- Triage likely correctness findings first, especially `B023` loop-variable capture, `F841` unused assignments, and `RUF012` mutable class attributes. Review each manually rather than treating them as formatting noise.
- Handle import-order (`I001`) and other mechanical fixes in small batches, running the backend suite after each batch.
- Review broad-exception (`BLE001`) findings individually. Several route and process boundaries intentionally catch exceptions to sanitize client errors while logging the real failure, so a blanket rewrite would be inappropriate.
- Review `UP`, `SIM`, `PIE`, and `FURB` modernization/style rules against the Python 3.9 compatibility requirement, then explicitly select or ignore rules that do not fit the project.
- Do not run a repository-wide `ruff check . --fix` until the target version and rule policy are committed. Keep lint cleanup separate from feature changes to preserve reviewable diffs.

Acceptance criteria:

- Ruff configuration documents the Python 3.9 target and intentional rule ignores.
- `ruff check .` passes, or only a small documented baseline of explicitly accepted findings remains.
- `python -m unittest discover tests -v` passes on supported Python versions after cleanup.

---

# Investigation Findings (2026-07-25)

Fact-finding only; no code changes made. Local baseline re-verified with the same
Ruff 0.16.0 (`pip`-installed; invoke as `python -m ruff` — the `ruff` binary is
not on PATH).

## Environment facts

- **No Ruff config exists.** No `pyproject.toml`, `ruff.toml`, or `.ruff.toml`
  anywhere in the repo. `ruff check . -v` confirms "Using Ruff default settings".
- **Ruff 0.16's default rule set is far broader than the legacy `E4,E7,E9,F`
  defaults.** Empirical probe (stdin file with deliberate violations) plus the
  baseline findings show the default now covers at least `F`, `I`, `UP`, `C4`,
  `SIM`, `BLE`, `B`, `PIE`, `TRY`, `FURB`, `PLW`, `FA`, `RUF`. Pycodestyle
  style rules are NOT in the default (`E501`, `E711`, `W291` do not fire).
- **Pinning an explicit `select` list EXPANDS scope.** An experiment with
  `select = ["F","I","UP","B","SIM","PIE","C4","TRY","FURB","PLW","RUF","BLE","FA"]`
  surfaced **131 findings** — 64 beyond the baseline — because the explicit
  families enable sub-rules outside Ruff's default set: TRY003 x49
  (`raise-vanilla-args`), TRY300 x5, SIM105 x3, UP015 x2, TRY301 x1, B904 x1,
  F405 x1, FURB171 x1, SIM108 x1. Those are untriaged and out of this task's
  scope. **Decision: do NOT set `select`; keep the default rule set** (it is
  what produced the baseline) and control drift by pinning the Ruff version
  when the CI lint job is added (see follow-ups). The 64 extra findings are
  logged here as a separate triage candidate.
- **Config validated empirically.** A draft `ruff.toml` with only
  `target-version = "py39"` and `ignore = ["BLE001","TRY004","FA100"]` yields
  exactly the **67 triaged findings** (verified via
  `ruff check . --config <draft> --statistics`).
- **Oldest supported runtime is Python 3.9.** CI matrix
  (`.github/workflows/tests.yml`): ubuntu 3.9 / 3.12 / 3.13, windows 3.12 / 3.13.
  Local interpreter is Python 3.14, so local runs cannot catch 3.9
  incompatibilities — only Ruff's `target-version` gate does. CI has **no lint
  job** today; adding one is an optional follow-up, not required for acceptance.
- **`docs/design-docs/` is gitignored**, so this log file is local-only working
  documentation, not a committed artifact.
- **Backend suite is green at baseline**: `python -m unittest discover tests`
  → `OK` (before any changes).

## Baseline reproduction and the py39 target effect

`ruff check . --statistics` reproduces the baseline exactly: 174 findings,
107 fixable. Breakdown:

| Count | Rule | Auto-fix | Category |
|------:|------|:--------:|----------|
| 56 | UP045 `non-pep604-annotation-optional` | yes | modernization (py310-only!) |
| 42 | BLE001 `blind-except` | no | intentional (see triage) |
| 17 | I001 `unsorted-imports` | yes | mechanical |
| 13 | UP035 `deprecated-import` | partial | mechanical |
| 9 | PIE807 `reimplemented-container-builtin` | yes | mechanical |
| 9 | SIM117 `multiple-with-statements` | partial | style |
| 6 | TRY004 `type-check-without-type-error` | no | intentional (see triage) |
| 5 | UP006 `non-pep585-annotation` | yes* | modernization (py39-safe) |
| 3 | UP022 `replace-stdout-stderr` | no | mechanical, manual |
| 3 | UP041 `timeout-error-alias` | yes | disappears under py39 |
| 2 | UP012 `unnecessary-encode-utf8` | yes | mechanical |
| 1 each | B023, F841, RUF012, RUF059, PLW1510, SIM102, PIE810, FURB188, RUF100 | mixed | correctness/single-site |

With `--target-version py39` the picture changes materially (171 findings):

- **UP045 x56 is replaced by FA100 x56** (`future-rewritable-type-annotation`,
  advisory, not fixable). No file in the repo has `from __future__ import
  annotations`, so `Optional[X]` → `X | None` rewrites would be **runtime
  syntax errors on Python 3.9**. Ruff correctly suppresses them under py39.
- **UP041 x3 disappears** (the `TimeoutError` alias rename is 3.10+).
- **UP006 fixes become "unsafe" under py39** (no longer plain `--fix`). The 5
  sites (`backend/context.py:60-61`, `backend/routing.py:37`,
  `backend/services/file_picker.py:12`) are all plain annotations; builtin
  generics (`tuple[...]`, `dict[...]`) are valid at runtime on 3.9 (PEP 585),
  so the fixes are safe — they just need `--unsafe-fixes` or hand edits.
- Fixable-by-default count drops 107 → 43.

Expected finding count after the proposed config (BLE001, TRY004, FA100
ignored): **67 findings**, all enumerated in the triage below.

## Correctness triage (the "review manually" list)

All four baseline-flagged correctness findings are in **test code**, not
production code:

- **B023** `tests/backend/test_extracted_routes.py:1140` —
  `find_tool_executable=lambda tool: executable` inside a `for` loop. The
  lambda is defined and consumed within the same iteration (`launch_process`
  is called before the next iteration binds `executable`), so there is **no
  real capture bug**. Fix anyway for lint-cleanliness: bind via default arg
  (`lambda tool, executable=executable: executable`).
- **F841** `tests/backend/test_extracted_routes.py:4025` —
  `target = self.ctx.paths.llama / "subdir"` is dead: never read, and the
  subdir is never even created. Safe to delete the line.
- **RUF012** `tests/backend/test_extracted_routes.py:2626` —
  `ImmediateThread.instances = []` is an **intentional** shared registry
  collecting every constructed fake thread. Fix idiomatically with a
  `ClassVar` annotation (`instances: ClassVar[list] = []`), which both
  silences RUF012 and documents intent. (Needs `ClassVar` import in the test
  file.)
- **RUF059** `tests/backend/test_extracted_routes.py:1667` —
  `ctx, process_handle = self._make_health_context()` never uses
  `process_handle`. Rename to `_process_handle`.

Production-code singles, all verified safe mechanical fixes:

- **PLW1510** `backend/services/file_picker.py:53` — `subprocess.run` result's
  `returncode` is checked explicitly right after (user-cancel detection), so
  raising is wrong. Add `check=False` to make intent explicit.
- **SIM102** `backend/services/git_update.py:90` — nested `if` with no `else`;
  safe to collapse into one condition.
- **PIE810** `backend/http.py:148` — merge two `startswith` calls into one
  tuple call: `path.startswith(("/js/", "/css/"))`.
- **FURB188** `backend/routes/chat.py:58` — `host[4:]` after
  `startswith("www.")` → `host.removeprefix("www.")` (`str.removeprefix` is
  3.9+, safe).
- **UP022 x3** `backend/services/process_manager.py:573,594,691` — all use
  `stdout=PIPE, stderr=PIPE` together; `capture_output=True` is equivalent.
  Manual fix (not auto-fixable); verify no site relies on separate PIPE
  objects afterward.

## Intentional-finding triage (candidates for documented ignores)

- **BLE001 x42 — all intentional.** Sampled routes (`routes/install.py`,
  `routes/chat.py`, `routes/git_update.py`, ...) catch `Exception` →
  `response.error(sanitize_error(e, 500), 500)`; `sanitize_error`
  (`backend/http.py:151`) logs the real exception to stderr and returns a
  generic 5xx message so paths/tracebacks never leak through the tunnel.
  Sampled services (`process_manager.py:1240`, `hf_download.py:123`,
  `app.py:731`, ...) catch → `print(..., file=sys.stderr)`. This matches the
  AGENTS.md error-handling contract exactly. Recommendation: ignore `BLE001`
  in config with a comment, rather than sprinkling 42 `# noqa`s.
- **TRY004 x6 — intentional.** All in `process_manager.py` validation helpers
  (`_parse_expected_generation`, `_canonical_fingerprint_json`,
  `_normalize_preflight_args`, ...) raising `ValueError` for bad input values.
  Callers catch `ValueError` (`backend/routes/process.py:62`, several internal
  `process_manager.py` sites). Switching to `TypeError` would ripple through
  call sites for no behavioral gain. Recommendation: ignore `TRY004` in config
  with a comment.
- **FA100 x56 — defer.** Only exists once `target-version = "py39"` is set.
  It advises adding `from __future__ import annotations`, which would unlock
  the UP045 modernization later. That's a separate project-wide decision
  (PEP 563 stringifies all annotations); ignore now, revisit as a follow-up.
- **RUF100** `server.py:12` — the `# noqa: F401,F403` on the star-import is
  flagged "unused" because those codes don't fire there under current
  defaults. Whether it stays unused depends on the pinned `select`; handle
  empirically during implementation (remove the noqa if RUF100 still fires
  with the committed config, keep it if `F403` fires without it).

## Mechanical-fix triage

- **I001 x17** — pure import sorting across 17 files (12 backend, 5 test).
  Ruff only reorders within contiguous import blocks, so `server.py`'s import
  side effects are unaffected. Safe `--fix`.
- **PIE807 x9** — `lambda: []` → `list` / `lambda: {}` → `dict`, 8 in
  `test_extracted_routes.py`, 1 elsewhere. Semantically identical (a fresh
  container per call either way). Safe `--fix`.
- **UP035 x13** — `from typing import Callable/Mapping/...` →
  `collections.abc` (auto-fixable, 3.9-safe). A few findings are deprecation
  *warnings* for `typing.Tuple`/`typing.Dict` on the same lines; these clear
  once the UP006 fixes below rewrite the usages.
- **UP006 x5** — see "py39 target effect": apply via `--unsafe-fixes` or by
  hand after eyeballing the 5 sites (all plain annotations, 3.9-safe).
- **UP012 x2** — `backend/http.py:256` (`encode("utf-8")` → `encode()`) and
  `tests/backend/test_services.py:104`. Safe `--fix`.
- **SIM117 x9** — merge nested `with` statements. 5 are auto-fixable; 4
  (`backend/routes/benchmarks.py:41`, `test_extracted_routes.py:1085, 3169,
  3880, 3905`) need manual edits (interleaved comments/mock setup). Behavior
  identical — context managers enter/exit in the same order.

# Implementation Plan

One commit per step; each step leaves the tree green. Run
`python -m unittest discover tests -v` after every step. All Ruff invocations
are `python -m ruff ...`.

### Step 1 — Commit the config, change nothing else

Create **`ruff.toml`** at the repo root (standalone file — the project has no
`pyproject.toml` and adding one could imply packaging semantics we don't want):

```toml
# Ruff lint policy for Llama GUI.
# CI runs Python 3.9/3.12/3.13; py39 is the floor. Local interpreters are
# newer, so this target is the only guard against 3.9-incompatible rewrites.
target-version = "py39"

[lint]
# No explicit `select`: the 174-finding baseline was produced with Ruff's
# default rule set, and an explicit family list enables ~64 additional,
# untriaged findings (see Investigation Findings). Pin the Ruff version in
# CI to keep the default set stable across upgrades.
ignore = [
    # Routes/services deliberately catch Exception to sanitize client errors
    # while logging the real failure to stderr (see sanitize_error in
    # backend/http.py and AGENTS.md "Error Handling Expectations").
    "BLE001",
    # Validation helpers raise ValueError by design; callers catch ValueError
    # (backend/routes/process.py, process_manager internals).
    "TRY004",
    # Deferred: adding `from __future__ import annotations` repo-wide is a
    # separate decision; until then PEP 604 rewrites are invalid on py39.
    "FA100",
]
```

Verify: `python -m ruff check . --statistics` reports exactly the 67 triaged
findings (17 I001, 13 UP035, 9 PIE807, 9 SIM117, 5 UP006, 3 UP022, 2 UP012,
9 singles) and nothing from BLE001/TRY004/FA100/UP041/UP045.

### Step 2 — Safe auto-fix batch

```
python -m ruff check . --fix --select I001,PIE807,UP035,UP012,SIM117,FURB188
```

(Expect ~30 fixes; the 4 non-auto-fixable SIM117 sites remain.) Run tests.
Eyeball `git diff` before committing — import reordering is the only
diff-noise risk.

### Step 3 — UP006 (5 sites, unsafe-fix or manual)

```
python -m ruff check . --fix --unsafe-fixes --select UP006
```

Confirm the diff touches only the 5 known annotation sites
(`backend/context.py:60-61`, `backend/routing.py:37`,
`backend/services/file_picker.py:12`). This also clears the remaining UP035
deprecation warnings. Run tests.

### Step 4 — Manual single-site fixes (9 sites)

Per the triage above: B023 default-arg binding, F841 line deletion, RUF012
`ClassVar` annotation, RUF059 rename, PLW1510 `check=False`, SIM102 collapse,
PIE810 tuple-startswith, UP022 `capture_output=True` x3, and the 4 remaining
SIM117 merges. Run tests.

### Step 5 — Close out

- Resolve the `server.py` RUF100/noqa question empirically (see triage).
- `python -m ruff check .` must report zero findings. Acceptance criteria met
  (config documents py39 target + ignores; suite green).
- Confirm no `docs/flag_report.md` or AGENTS.md updates are needed (no flag
  or workflow conventions change), except optionally noting the lint policy
  in `docs/directory.md` if the maintainers want it referenced there.

### Deferred follow-ups (not part of acceptance)

- Add `ruff` (version-pinned, e.g. `ruff==0.16.0`) to a dev-requirements file
  and a lint job to `.github/workflows/tests.yml` so the baseline cannot
  regress and the default rule set cannot drift silently.
- Revisit FA100/UP045: repo-wide `from __future__ import annotations` would
  unlock 56 PEP 604 modernizations.
- Triage the 64 findings surfaced by an explicit `select` list (TRY003 x49,
  TRY300 x5, SIM105 x3, UP015 x2, TRY301/B904/F405/FURB171/SIM108 x1 each)
  before adopting a pinned `select`. B904 (`raise ... from` inside `except`)
  has genuine correctness value and is the best candidate to adopt early.
- Consider `ruff format` as a separate, dedicated formatting pass.
