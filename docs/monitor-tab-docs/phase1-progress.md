# Monitor Tab — Phase 1 Progress (System endpoint)

Tracks `docs/monitor-tab-docs/monitor-plan.md` → "Phase 1 — System endpoint".

Status: **complete** (2026-09-04).

- [x] 1. Platform-neutral response builders and delta helpers — `backend/services/system_stats.py`
- [x] 2. Linux, Windows, and macOS CPU/RAM/disk collectors (Linux `/proc/*`; Windows `GetSystemTimes` / `GlobalMemoryStatusEx`; macOS Mach host stats — all via `ctypes`)
- [x] 3. Locked previous-sample / cache-generation state + coalesced forced-refresh rule — `backend/state.py` (`system_stats_lock`, `system_stats_collection_lock`, `system_stats_previous`, `system_stats_cache`, `system_stats_generation`, `system_stats_probe_cache`)
- [x] 4. NVIDIA and AMD command resolvers/parsers (CSV + multi-release JSON, UUID/PCI/BDF identity precedence with non-persistent index fallback)
- [x] 5. Evidence-gated, per-provider setup-state generation (`cuda` → NVIDIA; `hip`/`rocm`/`lemonade` → AMD; allowlisted apt/dnf/zypper commands; WSL-before-distro; unsupported platform states)
- [x] 6. Register `GET /api/system-stats` with validated `refresh=1` bypass — `backend/routes/system_stats.py`, `backend/app.py`
- [x] 7. Focused backend tests (`tests/backend/test_system_stats.py`, 56 tests) + route docs (`docs/directory.md`, `docs/architecture.html`)
- [x] 8. Verify: full backend unittest suite green (713 tests, project venv), `git diff --check` clean, live HTTP smoke test on Windows
- [x] 9. `docs/changelog.md` entry

## Acceptance checklist

- [x] Endpoint returns useful CPU/RAM/disk data without new packages. *(live smoke: Windows — CPU 2.1%, RAM 15.9/34 GB, disk 76%)*
- [x] Missing vendor tools produce setup states, not errors. *(covered by `SetupStateTests` + live run: no hint → empty `gpu_setup`, generic state owned by frontend)*
- [x] Irrelevant providers produce no setup cards; mixed-provider states coexist.
- [x] Mocked multi-GPU output returns separate stable entries. *(NVIDIA CSV 2-GPU fixture, AMD flat + nested release fixtures)*
- [x] A hung/malformed probe cannot hang or fail the whole endpoint. *(timeout → `error` status; malformed CSV rows/JSON rejected individually; sibling metrics unaffected)*
- [x] Slow vendor probes do not distort CPU/disk intervals; simultaneous Recheck requests cause at most one new collection. *(timestamps captured beside counter reads before probes; generation-coalescing tests)*
