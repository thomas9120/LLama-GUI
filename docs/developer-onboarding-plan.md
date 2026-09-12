# Developer Onboarding Plan — Audit and Tracked Work Items

> **Tracking document (audit 2026-09-11, commit `710d36c`).** This file records a
> new-developer onboarding audit and the improvement items that came out of it, so
> the work can be resumed later without redoing the audit. Every finding carries
> verified file/line evidence, and every work item states its own acceptance criteria.
> Check items off as they land. Once every accepted item is done (or explicitly
> rejected), delete this file and its Documentation Index row — the repo convention
> is to prune completed planning docs, not keep them.

## How to resume

1. Read this file top to bottom. Work items are self-contained; no re-audit needed.
2. Decide the execution order — the P0–P3 labels are the audit's suggestion, not a
   commitment (see [Open decisions](#open-decisions)).
3. Mark items `[x]` with a completion note as they land.

## Audit method

Walked the path a first-time contributor would take: read `README.md` →
`AGENTS.md` → `docs/directory.md` → `docs/tests.md` → `docs/maintenance.md`,
then navigated code and tests the way a newcomer would (grep + open file).
All evidence was verified on 2026-09-11 at commit `710d36c`; line numbers refer
to that state.

## What already works — do not break

The foundations are unusually strong. Any improvement must preserve these:

- `AGENTS.md` is a real rulebook: ownership, pitfalls, and a change-type →
  required-test verification table.
- `docs/directory.md` is a genuine reference manual: module map, script order,
  API table, data flow.
- Drift is caught mechanically, not by discipline: `tests/backend/test_docs_sync.py`
  keeps the route tables honest, `tests/frontend/module_namespace_unit.cjs`
  enforces script load order, `tests/frontend/theme_ui_unit.cjs` enforces theme
  contracts. This "meta-test" pattern is the repo's best onboarding asset.
- The frontend dev loop is smooth: HTML is served `no-store`, so it is
  save + browser refresh; only backend edits need a `server.py` restart.
- Backend architecture is consistent and readable (routes/services/state/context
  split, `Router`, `sanitize_error()`, lock discipline).
- User-facing onboarding is covered: `README.md` "First Run" walks a *user* from
  install to a working launch.
- Conventional markdown links resolve: all 19 relative `](...)` links across
  tracked `.md` files exist. The dead references found below are backtick-quoted
  paths, not links — a checker must cover both forms (see W3).

## Findings

### F1 — No developer onboarding path (biggest gap)

The README is written for users; `AGENTS.md` for AI agents; `docs/maintenance.md`
is 60 lines. A human contributor must synthesize "clone → venv →
`pip install -r requirements.txt` → `npm ci` → `npx playwright install chromium`
→ run these tests → `python server.py` → open `http://127.0.0.1:5240`" from three
documents, none of which states it end to end. `docs/tests.md` has the pieces
(venv command, Playwright install) but assumes you already know the setup.

### F2 — Documentation drift: dead references (verified inventory)

Nothing mechanically checks doc-index references, and docs were deleted without
updating `directory.md`. Verified missing (backtick-quoted paths):

| Location | Dead reference |
|---|---|
| `docs/directory.md:621` | `docs/design-docs/preset-todo.md` (inline: "see the notes in …") |
| `docs/directory.md:1098` | `docs/custom-model-plan-final.md` |
| `docs/directory.md:1099` | `docs/editable-launch-command-plan.md` |
| `docs/directory.md:1102` | `docs/todo.md` |
| `docs/directory.md:1103` | `docs/design-docs/bugtracker.md` |
| `docs/directory.md:1104` | `docs/design-docs/preset-todo.md` |
| `docs/directory.md:1105` | `docs/ui-ux-polish.md` |
| `docs/directory.md:1106` | `docs/design-docs/router-mode.md` |
| `docs/directory.md:1107` | `docs/design-docs/flag_report.md` |
| `docs/directory.md:1108` | `docs/design-docs/llama_cpp_compat_report.md` |
| `docs/frontend-module-split-plan.md:70` | `docs/changelog.md` |

Cause: deletion commits ("docs cleanup" `882a7ea`, "Delete ui-ux-polish.md"
`1e88187`, "Delete changelog.md" `571b4e3`, "Delete custom-release-import-plan.md"
`a3e455e`, …) did not update the index. A new dev following the "companion
reference" hits 404s immediately and discounts the rest of the docs.

Two categories exist and must be treated differently by any checker:

- **Living docs with dead refs** (the table above): real drift, fix in W1.
- **Archived/completed plan docs that intentionally reference pre-rename
  filenames** — `docs/frontend-module-split-plan.md` mentions the former
  `ui/js/chat-ui.js` / `ui/js/presets.js` monoliths, and
  `docs/frontend-maintainability-tier-2-plan.md` mentions files that were
  never created or were renamed. These are implementation records, not drift.
- **Upstream paths**: `docs/upstream-changes.md:39` mentions
  `tests/test-speculative-adaptive.cpp` etc. — those are llama.cpp's own files
  in the fork description, not repo paths.

### F3 — `maintenance.md` recommends the exact documented test trap

`docs/maintenance.md` says to run backend tests with
`python -m unittest discover tests -v`, but `AGENTS.md` warns: "Use the
**project venv** for backend tests … System Python may lack runtime
dependencies and produce misleading failures" (missing `huggingface_hub`).
`docs/tests.md` gives the correct venv command. The repo contradicts itself;
a new dev following `maintenance.md` walks straight into the one known trap.

### F4 — The reference manual is a novel, not a map

`docs/directory.md` is ~1,100 lines of high-quality but front-loaded prose.
No reading order is stated; critical rules ("never mutate
`flagCore.getFlagValues()`", "never emit `-cd`/`ctx_size_draft`") are buried
mid-file. The Top-Level Directory Map lists `tools/` without noting it is
runtime-created (git-ignored; absent until first tunnel use) and omits
`online_installers/`, `Linux_compile_toolkit/`, `release.bat`/`release.ps1`,
and `stash-updates.bat`.

### F5 — The frontend module system is unusual and implicit

48 `<script>` tags in strict order in `ui/index.html` (47 src = all 47
`ui/js/` files + 1 inline); dependency injection via `configure()` calls from
`app.js` (15+ wiring points); private script-global packages
(`ui/js/presets/*`, `ui/js/chat/*`). A dev from a modern JS background must
learn: "where does `showToast` come from?" → injected by `app.js`, and nothing
in the consuming file says so. The *docs* cover this; the *files* mostly don't
self-describe: 21 of 47 `ui/js` files have a role header, 26 do not — including
`app.js` (1,545 lines), `manager.js` (1,481), `config-flags-ui.js` (1,317),
`chat-window.js` (2,231), `benchmark-ui.js` (1,073), `quick-launch-ui.js`
(1,016), and `flag-core.js` (857). Files that do it right:
`ui/js/chat/chat-stream.js` ("Chat package (6/8): …"),
`ui/js/presets/presets-crud.js`, `ui/js/monitor-ui.js`.

### F6 — "Where do I change X?" is answered only after reading the manual

`directory.md`'s module tables answer ownership, but grep-then-read is the
natural workflow and most files don't self-describe (see F5). Element IDs are
consistent and grep-friendly (`preset-name-input`, `section-quick-launch`) —
no change needed there. The `.codegraph/` local code-index daemon
(git-ignored) is useful for tooling users but is mentioned in no doc.

### F7 — Domain knowledge is a hidden prerequisite

This is a GUI over llama.cpp: build tags (`b10875`), `removed_in`/`fork_only`
flag lifecycle, template presets, `tests/llama-cpp-pin.json` pinning. A new
dev cannot safely touch the flag system without this model, and it is
scattered across `AGENTS.md` + `directory.md`'s Flag System section +
`docs/upstream-changes.md`. No single primer ties it together.

### F8 — Smaller frictions

- **"Done" is several commands**: `npm test` (frontend) plus a separate venv
  unittest run (backend). No single entry point runs what CI runs.
- **No JS lint**: only `node --check` via `js_syntax_check.cjs`. In a
  no-module frontend, a typo'd global fails only at runtime. Python has a
  documented `ruff.toml` policy; JS has no equivalent.
- **Humans may skip `AGENTS.md`** because of its name; nothing in README
  points contributors at it.

## Work items

Status legend: `[ ]` open · `[x]` done (add date + commit) · `[~]` in progress ·
`[-]` rejected (record why).

### W1 (P0) — Repair dead doc references — DONE 2026-09-11

- [x] Removed the nine dead rows from `directory.md`'s Documentation Index.
  Decision per row: **drop**, all nine. The five `docs/design-docs/*` files
  were never tracked in git (no history exists — they lived only on disk), so
  they are unrecoverable and those rows were stale from the start. The four
  tracked deletions (`custom-model-plan-final.md`, `editable-launch-command-plan.md`,
  `todo.md`, `ui-ux-polish.md`) were deliberate "docs cleanup" removals and
  remain recoverable from git history if content is ever needed.
- [x] Rewrote the case-only-rename sentence inline from the actual behavior in
  `backend/routes/presets.py` (rename against the requested spelling because
  Windows `Path` equality/`resolve()` are case-insensitive; `samefile()`
  distinguishes a case-only rename from a genuine collision), instead of
  pointing at the deleted `preset-todo.md`.
- [x] Reworded `docs/frontend-module-split-plan.md`'s changelog step as
  historical ("the changelog file has since been removed") — no dead path
  reference remains.
- **Acceptance**: repo-path scan over living docs now finds zero references to
  non-existent files (verified below; W3 will enforce it mechanically).
- **Effort**: ~1 hour.

### W2 (P0) — Align `maintenance.md` test commands with `AGENTS.md` — DONE 2026-09-11

- [x] Replaced the plain backend test command in `docs/maintenance.md` with
  both venv invocations (`.venv\Scripts\python.exe` on Windows,
  `.venv/bin/python` on Unix) plus the missing-`huggingface_hub` warning,
  matching `docs/tests.md`'s wording; the `docs/tests.md` pointer was already
  present and kept.
- [x] Scope addition found during implementation: `docs/architecture.html`
  carried the same bare command in two places (Tests card `<pre>`,
  backend-route recipe `<li>`) — both now venv-qualified, and the Tests card
  gained a project-venv note mirroring the frontend card's style. Covered by
  W2's acceptance criterion ("no living doc recommends plain system Python").
- **Acceptance**: verified — the only remaining bare `python -m unittest`
  strings in docs are this file's own audit quotes (they describe the problem,
  not prescribe it; exempt from W3's checker like archived plan docs).
- **Side finding**: architecture.html's Tests card counts/lists are stale
  (says "Backend — 10 files", actual 17; "Frontend — 25 `.cjs` files",
  actual 35; verified 2026-09-11) — tracked as a new W5 bullet.
- **Effort**: ~15 minutes planned; ~30 with the architecture.html scope.

### W2b (P0) — Retire `docs/architecture.html` — DONE 2026-09-11

Decision made 2026-09-11 during the D4/W3 design discussion (user-approved):
retire rather than slim or keep. Evidence:

- 13 of the 14 commits touching it were feature catch-up ("sync architecture
  docs" literally appears in commit subjects) — a per-feature tax on top of
  `directory.md`, which must be updated anyway.
- Unenforced content rotted: test-file counts ("10 files"/"25 `.cjs`" vs
  actual 17/35), duplicated bare test commands, "1.7k lines" for a
  1,891-line `index.html`, "15 routes modules / 13 services" vs actual 17/15.
- Content was ~90% duplicated from `directory.md` (layer map ≈ Architecture
  section, ladder ≈ Script Loading Order, API table ≈ Route Modules,
  recipes ≈ AGENTS.md, Tests ≈ tests.md).
- README never linked it — contributor-facing only, so retirement has no
  user-facing impact.

Work done:

- [x] Salvage pass. Ported what `directory.md` lacked: the `config.py`
  no-optional-imports constraint (module table), the 10 MB request-body cap /
  `Transfer-Encoding`-refused / 408-timeout contract, and the no-WebSocket
  live-update design statement (Architecture bullets). The generation-cursor
  contract was already documented (`directory.md`, process-output section);
  the lock inventory and polling-cadence table were deliberately not ported
  (self-documenting in `backend/state.py` and per-feature docs — porting them
  would recreate the sync burden just removed).
- [x] Deleted `docs/architecture.html` (1,488 lines).
- [x] Halved `tests/backend/test_docs_sync.py` — dropped the HTML table
  check, its regex/helpers, and updated the docstring and comments.
- [x] Updated `AGENTS.md` (route rule), `docs/tests.md` (drift-test
  description), and `docs/directory.md` (index row; also fixed the stale
  `docs/` directory-map description that still named deleted docs).
- Archived plan docs' historical `architecture.html` mentions were left
  as-is (implementation records; exempt from the W3 checker).
- **Effort**: ~1.5 hours.

### W3 (P0) — Add a docs-reference checker test

Design resolved 2026-09-11 (D4): **scan all tracked docs with explicit
exemptions** (denylist), not a living-docs allowlist — new docs are protected
by default, the failure direction is loud (false positive) rather than silent
(unprotected doc), and W2b removed `architecture.html` so the scope is
markdown only.

- [ ] New `tests/backend/test_docs_links.py`: scan every tracked `.md` file
  (repo-root `README.md`, `AGENTS.md`, everything under `docs/`) for
  (a) relative markdown links and (b) backtick-quoted repo-relative paths
  (`docs/…`, `ui/…`, `backend/…`, `tests/…`, `scripts/…`), and assert each
  resolves to an existing file. Runtime-created directories (`llama/`,
  `models/`, `presets/`, `tools/`) are deliberately outside the prefix list.
- [ ] `EXEMPT_DOCS`, each entry with a reason comment: the two archived plan
  docs (intentional pre-rename references) and this tracking doc (quotes dead
  paths as audit evidence). Self-verifying: every exempted doc must exist on
  disk, so deleting an exempted doc flags its stale exemption.
- [ ] `UPSTREAM_PATHS` allowlist for llama.cpp's own files that collide with
  repo prefixes: `tests/CMakeLists.txt`, `tests/test-arg-parser.cpp`,
  `tests/test-speculative-adaptive.cpp` (referenced by
  `docs/upstream-changes.md` fork notes).
- **Acceptance**: passes today (W1 cleaned living docs); adding a reference
  to a deleted file — or deleting a referenced file — fails CI.
- **Verify**: `.venv/Scripts/python.exe -m unittest tests.backend.test_docs_links -v`
  (or the whole suite: `.venv/Scripts/python.exe -m unittest discover tests -v`).
- **Effort**: ~2–3 hours.

### W4 (P1) — Developer quickstart (CONTRIBUTING.md or docs/dev-guide.md)

- [ ] One page: prerequisites; setup (venv → `pip install -r requirements.txt` →
  `npm ci` → `npx playwright install chromium`); run (`python server.py` →
  `http://127.0.0.1:5240`); dev loop (edit `ui/` → refresh; edit `backend/`
  → restart); test commands incl. a pointer to `AGENTS.md`'s change-type →
  required-test table; a "read `AGENTS.md` — it is for human contributors too"
  note; reading order for the docs.
- Location is open decision D2 — root `CONTRIBUTING.md` is GitHub-conventional
  and shows up in PR UIs; `docs/dev-guide.md` fits the docs index.
- **Acceptance**: a new dev following only this page gets from clone to a
  running app and green tests without reading any other doc first.
- **Effort**: ~2 hours.

### W5 (P1) — Reading-order path at the top of `directory.md`

- [ ] Small "New here? Read in this order" box: 1) `AGENTS.md`, 2) this file's
  Architecture + Frontend Module Reference sections, 3) `docs/tests.md` Common
  Commands, then everything else on demand.
- [ ] Top-Level Directory Map: mark `tools/` as runtime-created, add the
  omitted top-level entries (`online_installers/`, `Linux_compile_toolkit/`,
  `release.bat`/`release.ps1`, `stash-updates.bat`).
- [x] ~~`docs/architecture.html` Tests card stale counts~~ — moot: the file
  was retired in W2b (2026-09-11).
- (The index prune itself happens in W1.)
- **Acceptance**: a newcomer can answer "what do I read first" in one glance.
- **Effort**: ~1 hour.

### W6 (P2) — Standardize role headers in `ui/js/` + new-module walkthrough

- [ ] Add a 1–3 line role header to the 26 no-header files; package members
  get position markers matching the existing convention
  ("Presets package (9/10): …", "Chat package (6/8): …").
- [ ] Add an "Adding a new frontend module" walkthrough (in the W4 page or
  `directory.md`): `index.html` placement rules (after dependencies, before
  consumers), a `configure()`-injection skeleton, and which checks to run
  (`npm run test:frontend:modules`, `npm run test:frontend` when DOM wiring
  is touched).
- **Acceptance**: every `ui/js` file's first lines state its role; the
  walkthrough exists with a copy-paste skeleton.
- **Verify**: `node --check` on touched files; `npm run test:frontend:modules`.
- **Effort**: ~3–4 hours (mostly mechanical; review for accurate descriptions).

### W7 (P2) — llama.cpp compatibility-model primer

- [ ] One half-page section (inside `directory.md`'s Flag System area or a
  standalone doc) tying together: `ui/js/flags/definitions.js` ↔ upstream
  `common/arg.cpp` verification; `false_flag`; `fork_only` +
  `docs/upstream-changes.md`; `removed_in` build-tag gating and
  build-tag-checked behavior; `tests/llama-cpp-pin.json` and the CI
  flag-compat job. Link the new-flag checklist in `AGENTS.md` rather than
  duplicating it.
- **Acceptance**: a new dev can safely make a first flag change from one place.
- **Effort**: ~2 hours.

### W8 (P3) — One-command local check

- [ ] `npm run test:all` (or a `scripts/` helper) that runs the frontend suite
  plus backend unittest with the project venv, cross-platform. Keep the
  Playwright requirement out of the fast path (mirror `npm test`'s structure).
- **Acceptance**: one command runs the same checks CI runs.
- **Effort**: ~1–2 hours (mostly cross-platform venv resolution).

### W9 (P3, decision) — ESLint for the frontend

- Pro: `no-undef` / `no-unused-vars` catch runtime-only typos in a 25k-LOC
  no-module frontend where nothing type-checks globals.
- Con: a new devDependency versus the repo's minimal-deps culture
  (Playwright is the only devDep today); `js_syntax_check.cjs` is trivially
  cheap.
- Middle ground: ESLint with a tiny config (globals: `window`, `document`, …)
  and no plugins, pinned in devDependencies, wired into `npm test`.
- **Decision owner**: maintainer. See open decision D3.

### W10 (P3) — Split `directory.md` deep feature sections into per-feature pages

- Candidates: Presets Tab, Chat Tab, secondary-screen presentation, and the
  auto-update internals → linked per-feature pages; `directory.md` keeps the
  map, script order, and module reference.
- Risk: more files to keep in sync (W3's checker mitigates). Only do this if
  `directory.md` keeps growing; see open decision D5.

## Open decisions

| # | Question | Default suggestion |
|---|---|---|
| D1 | Execution order of W1–W10 | W1 → W2 → W3 first: make existing docs truthful and mechanically protected *before* adding new docs (W4–W7) that could rot the same way. |
| D2 | Quickstart location: root `CONTRIBUTING.md` vs `docs/dev-guide.md` | Root `CONTRIBUTING.md` (GitHub surfaces it); index it in `directory.md`. |
| D3 | ESLint: yes / no / middle ground | Middle ground (tiny config, no plugins), if the maintainer accepts the devDependency. |
| D4 | Link-checker scope: living-docs allowlist vs all docs with per-file exemptions | **RESOLVED 2026-09-11:** all-docs scan with explicit exemptions (denylist) — see W3. New docs are protected by default; the failure direction is loud rather than silent; self-verifying exemptions catch their own staleness. W2b removed `architecture.html` from scope. |
| D5 | Whether to split `directory.md` at all | Defer until it grows again after W4–W7 land. |

## Things the audit checked and found OK (do not re-check)

- `localStorage` usage is contained in 7 files, each owning documented keys
  (`docs/directory.md` documents the preset keys).
- Backend route modules are small and consistent; `backend/routes/status.py`
  reads like a template for a new route.
- `test_docs_sync.py` route-table enforcement works and is a good anchor
  pattern for W3.
- Static HTML is served `no-store` (`backend/app.py`), so frontend iteration
  needs no server restart.
- The `configure()` DI convention is consistently applied (15+ `configure()`
  call sites in `app.js`); the problem is discoverability, not consistency.
- CI (`.github/workflows/tests.yml`) is a faithful "definition of done":
  Linux/Windows Python matrix, frontend suite + pinned llama.cpp flag-compat
  on ubuntu/3.13; the no-macOS exception is deliberate and dated in
  `AGENTS.md`.