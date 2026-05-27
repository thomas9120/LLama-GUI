# Review Report: AGENTS.md → directory.md Migration + Security Audit

**Date:** 2026-05-24  
**Scope:** Content migration from AGENTS.md to docs/directory.md, plus security audit of the Llama GUI repository

---

## Migration Review

Three reviewers audited the migration: correctness/completeness, security, and docs quality.

### Fixes (Applied)

| # | Finding | File | Fix |
|---|---------|------|-----|
| F1 | Stale `flags.js` references — monolithic file was split into `flags/definitions.js` and `flags/chat-templates.js` | AGENTS.md:87, directory.md:246, directory.md:392 | Updated to correct paths |
| F2 | FLAGS count wrong — said 134, actual count is 138 | directory.md Flag System section | Corrected to 138 with note |
| F3 | Missing `Deepseek v2.5 & v3` from Built-In Mappings table | directory.md Chat Template Presets | Added the builtin mapping |
| F4 | Documentation Index errors — `frontend_flag_core_plan.md` is at `docs/archive/`, `frontend_modularization.md` doesn't exist, missing `bugtracker.md` and `mockups/` | directory.md bottom table | Fixed paths, removed phantom entry, added missing entries |
| F5 | Missing upstream verification sources in llama.cpp Compatibility — lost `llama-server --help` and `examples/server/README.md` references | directory.md llama.cpp Compatibility section | Restored detailed verification steps |

### Deferred (Optional Improvements)

| # | Finding | Reason to Defer |
|---|---------|------|
| O1 | Script Loading Order duplicated in AGENTS.md + directory.md | Useful context in both locations; dual maintenance risk is acceptable |
| O2 | File Ownership table could use "see directory.md for architecture" note | Table is self-contained; pointer already exists at top of AGENTS.md |
| O3 | Auto-Update CORS note dropped from old AGENTS.md | Redundant with CORS architecture described elsewhere in directory.md |
| O4 | KoboldCppAutomatic explanatory "why" sentence trimmed | Behavior is still fully documented; the explanation adds minor clarity only |

---

## Security Audit Findings

No blockers or critical issues. All findings are pre-existing — not introduced by the docs migration.

### Medium Severity

| # | Finding | Location | Detail |
|---|---------|------|--------|
| S1 | **No integrity verification for cloudflared binary download** | `backend/services/tunnel.py:49-103` | Downloads from GitHub releases without checksum/signature. TLS is used (MITM on network level unlikely), but supply-chain compromise of GitHub CDN or account could deliver malicious binary. Add SHA256 verification from a known manifest if possible. |
| S2 | **CORS allows any IP-based Origin when bound to 0.0.0.0** | `backend/http.py:68-72` (`is_ip_literal`) | By design for LAN access, but no authentication layer. Any client on allowed origins can call all API endpoints. Consider adding an optional API key for non-localhost deployments. |
| S3 | **`.env` files in safe path list for auto-update** | `backend/services/git_update.py:85` | `.env` files won't block auto-updates. `git pull --ff-only` requires clean working tree, so this only risks committed `.env` changes being overwritten. Low practical risk but worth documenting. |
| S4 | **`tarfile` extraction without `filter='data'`** | `backend/services/llama_manager.py:349` | Current flattening logic mitigates path traversal. Python 3.12+ `filter='data'` parameter would add defense-in-depth for symlink handling. Symlinks are created with controlled paths (relative filenames only). |

### Low Severity

| # | Finding | Location | Detail |
|---|---------|------|--------|
| S5 | `open-folder` silently falls back to models dir for unknown folder names | `backend/routes/lifecycle.py:17-24` | Should return 400 for unknown values instead of silent fallback |
| S6 | `ddgs>=7.0.0` unpinned upper bound | `requirements.txt` | Could pull breaking API changes. Consider `>=7.0.0,<8.0.0` |
| S7 | No authentication on any API endpoint | All routes | Any client on allowed origins can launch/stop processes, download models, start tunnels. Expected for localhost-first tool, risky on LAN |
| S8 | No rate/size limit on `send_input` stdin text | `backend/routes/process.py:30-32` | Could flood running process stdin. Limited by origin validation |
| S9 | No checksum verification for llama.cpp releases when GitHub metadata lacks SHA256 | `backend/services/llama_manager.py:230-234` | Logs a warning but proceeds with unverified download |

### What's Done Right

- **No `shell=True`** anywhere in the codebase — all subprocess calls use list-form arguments
- **HF input validation is solid** — repo IDs, revisions, filenames all validated with strict regex
- **Preset path traversal blocked** — `get_preset_file_path()` verifies parent directory matches expected root
- **Error sanitization** — `sanitize_error()` hides internals from clients while logging to stderr
- **Body size limits** — 10MB cap on request bodies
- **Sentinel comparison** — `_BODY_TOO_LARGE` compared with `is` not `==`
- **No hardcoded secrets** — no tokens, passwords, or API keys found
- **Tunnel URL validation** — strict `*.trycloudflare.com` regex prevents URL injection