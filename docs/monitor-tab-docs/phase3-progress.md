# Monitor Tab — Phase 3 Progress (Documentation and compatibility)

Tracks `docs/monitor-tab-docs/monitor-plan.md` → "Phase 3 — Documentation and compatibility".

Status: **complete** (2026-09-04). Pinokio launcher check **deferred** by user decision.

- [x] 1. `docs/directory.md` — script order (21. `monitor-ui.js`), module table, tabs list, service/route tables, endpoint count 48 (done across Phases 1–2, re-verified)
- [x] 2. `docs/architecture.html` — API surface row for `GET /api/system-stats` (Phase 1); tabs table now "The eight tabs" with a Monitor row; launch-flow step 8 and the polling table describe the shared 2 s inference cycle (independent `/metrics` + `/slots`) and the visibility-gated `/api/system-stats` poll; "7 tabs" / line-count references updated
- [x] 3. `AGENTS.md` — "Where to edit" rows for Monitor tab / shared inference snapshot, output cursor, and system-stats backend
- [x] 4. `README.md` — Monitor added to "What Each Tab Does", First Run step 4 points at Monitor for startup logs, Monitor screenshot captured at the same 1350×1013 size as the existing set (`docs/images/monitor.png`)
- [x] 5. `docs/changelog.md` — feature entries already written with Phases 1–2 (docs-only changes are excluded by changelog policy)
- [x] 6. Pinokio launcher check — **deferred** (user will do it later)
- [x] `docs/troubleshooting.md` — stale "Output in Configure" reference now points at the Monitor tab
- [x] `tests/backend/test_docs_sync.py` green (4/4), full backend suite 713 OK, `git diff --check` clean
- [x] Fork-only flag handling: `--spec-draft-adaptive` stays (experimental, LaurentZuijdwijk fork) but its definition now carries `fork_only: true`; `llama_flags_supported_unit.cjs` skips marked flags when comparing against an installed binary's `--help`, and `flag_definitions_unit.cjs` enforces fork-only flags to be bools defaulting to false. Convention documented in AGENTS.md and `docs/upstream-changes.md`.
