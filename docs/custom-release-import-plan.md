# Custom llama.cpp release import plan

**Status:** Deferred; not implemented. Resume only when the maintainer requests implementation.  
**Created:** 2026-09-07  
**Scope:** Download a user-selected GitHub release archive into the existing Custom backend.

## Goal and agreed decisions

Remove the manual download, extraction, and file-moving steps when using forks such as [Unsloth's llama.cpp releases](https://github.com/unslothai/llama.cpp/releases), while keeping Install & Update simple.

- Show the importer only when the existing **Custom** backend is selected.
- Accept a GitHub release link and let the user explicitly choose the package. Do not guess the GPU variant.
- Clearly state that installation replaces the existing custom build, including files manually added within the replacement directory.
- Download, extract, and validate the replacement before moving the existing build aside. Install into a clean directory; never merge old and new runtime libraries.
- Restore the previous installation and active-build settings if replacement or activation fails.
- Detect and explain missing runtime dependencies. **Do not automatically download runtimes, discover PyTorch installations, install drivers, or assemble multiple dependency packages.** The maintainer explicitly agreed to this limit.
- Keep manual Custom setup and activation available.
- This document records future work only. It does not authorize implementation, downloading a build, or replacing the maintainer's current installation.

## Proposed first-version boundaries

These are implementation defaults derived from the discussion, rather than additional features already requested.

| Area | Proposed behavior |
| --- | --- |
| Sources | Public releases on `github.com`; no private-repository credentials or arbitrary download hosts |
| Link forms | Repository releases page, a specific release, `releases/latest`, or a direct GitHub release-asset link |
| Release selection | A releases-page link shows a release selector; a specific release fixes that selection; a direct asset link also selects its asset |
| Asset selection | Show full filename and size; require an explicit choice when the link does not identify an asset |
| Formats | `.zip`, `.tar.gz`, and `.tgz`; explain unsupported formats |
| Packages | One archive containing the required tools and a supported runtime layout; separate runtime installation remains manual |
| Required tools | `llama-server` and `llama-cli`, with the platform's executable suffix |
| Optional tools | `llama-bench` and `llama-perplexity`; absence is reported without rejecting an otherwise usable build |
| Replacement scope | Replace all of `llama/custom/bin/`, including its nested files and directories |
| Custom grammars | Preserve `llama/custom/grammars/`; do not automatically import or replace separate grammar assets in this version |
| Activation | Activate Custom after successful installation, without automatically starting a model |
| Updates | Revisit the importer and explicitly choose another release/package; no automatic fork updates |
| Recovery | Temporary backup for installation failure and interrupted replacement; no permanent build history or rollback UI |

Preserving the separate grammars directory gives the replacement warning an exact boundary. Models, presets, user configuration outside the installation metadata, and the official installation must remain intact. A package that cannot run within the supported binary layout should receive an actionable error, rather than cause writes elsewhere under `llama/custom/`.

## User flow and copy

1. Select **Custom** in the existing Backend selector.
2. Open a small **Download from GitHub release** disclosure within the Custom section. Keep the existing manual setup instructions and **Activate Custom** action available.
3. Paste a supported link and choose **Load release**. Looking up releases must not download or execute binaries or reserve the install slot.
4. Choose a release when needed, then choose an archive. Exclude GitHub's generated source-code archives and non-package assets such as checksum files. Filename hints can assist selection, but must not claim hardware compatibility or hide uncertain matches.
5. Display the resolved repository, release tag, full asset filename, download size, and destination. Resolve `latest` at lookup time and bind installation to that selection.
6. Show the replacement warning beside the action, before submitting the install request:

   > This will replace your current custom llama.cpp build and all files in `llama/custom/bin/`, including files you added manually. Your models, presets, and custom grammars are unaffected.

   > Download and run builds only from publishers you trust. Some packages require runtime libraries installed separately.

7. Use **Replace Custom Build** when the destination has contents, and **Download & Activate** for a fresh installation. Clicking the explicit action authorizes the displayed replacement; avoid adding a second redundant confirmation flow. The backend must independently enforce replacement acknowledgement when existing contents are present.
8. Reuse installation progress and status for download, verification, extraction, validation, and activation. Disable conflicting actions while the backend owns the install slot. Reject stale lookup responses and duplicate clicks.
9. On success, refresh shared installation status and show the installed source and any optional-tool or unchecked-runtime notices. On failure, show the actionable reason and whether the previous build was preserved or restored.

For simplicity, use the existing install interlock: require the user to stop any GUI-managed llama.cpp process before beginning installation, and prevent launches until it finishes. Do not silently stop a running model. A process started outside the GUI can still lock files; handle that failure without deleting the old installation.

## Current implementation and reuse points

Recheck these locations when implementation resumes. Use CodeGraph first while the repository has a `.codegraph/` directory, and read [directory.md](directory.md) and [tests.md](tests.md).

| Location | Existing behavior / intended responsibility |
| --- | --- |
| `ui/index.html` | Existing `custom-backend-info` area and shared install progress controls; place the importer here |
| `ui/js/manager.js` | Backend selection, `showCustomBackendControls()`, `activateCustomBackend()`, release lookup, shared `fetchJson()`, status rendering, and installation progress |
| `backend/routes/install.py` | Official install/update routes and manual Custom activation; own the import API orchestration and worker lifecycle |
| `backend/services/llama_manager.py` | GitHub metadata lookup, downloading, checksums, extraction, directory swapping, and Custom activation |
| `backend/services/process_manager.py` | `claim_install_slot()` / `release_install_slot()` and the launch/install interlock |
| `backend/state.py` | Locked install state, progress, and runtime-health cache |
| `backend/config.py`, `backend/context.py` | Canonical Custom paths and service injection; avoid redefining paths in the UI |
| `backend/routes/status.py` | Expose optional custom-source metadata through the existing status response |
| `backend/app.py` | Route registration and, only if necessary, startup recovery wiring |

Prefer a focused `backend/services/custom_release.py` for the new URL, asset-selection, and import orchestration logic, reusing narrow helpers from `llama_manager.py`. Avoid a general package-manager framework or unrelated installer rewrite. Keep frontend behavior in `window.LlamaGui.manager` unless its size warrants a focused `window.LlamaGui` module; add no globals to `app.js`.

Existing helpers need review before reuse:

- `install_release()` targets the official installation and writes official metadata. Do not point it at Custom by temporarily mutating shared context or global paths.
- `extract_archive_flat()` flattens paths and routes JSON files to grammars. That can break a fork's runtime layout or move its build metadata.
- `extract_archive_preserve_paths()` skips tar links. Simply reusing it can omit required shared-library aliases.
- `download_file()` currently reports bytes without enforcing a complete expected-length match. The importer needs explicit length and digest verification and a validated redirect policy.
- `_swap_directory_into_place()` provides useful in-process rollback mechanics, but does not provide complete crash recovery. It also removes a pre-existing `.old` directory; an unresolved recovery backup must never be discarded this way.
- `activate_custom_backend()` checks required filenames and Unix executable permissions and delegates runtime inspection. Runtime inspection is currently unavailable on Windows, and inspector failures can be recorded as unchecked. Its success is not proof of GPU or model compatibility.

## Backend contract

Use explicit import endpoints rather than changing the semantics of official `/api/install` or manual `/api/activate-custom`. Proposed names, to finalize at implementation time:

| Endpoint | Contract |
| --- | --- |
| `POST /api/custom-release/resolve` | Validate a supplied link and return bounded release/asset metadata. A selected tag can resolve the asset list after a releases-page lookup. No installation side effects. |
| `POST /api/custom-release/install` | Accept the resolved repository, tag, release/asset identifiers, and replacement acknowledgement; validate again, claim the install slot, and start the import worker. |
| `GET /api/download-progress` | Reuse the existing progress endpoint for this operation. Expose enough operation identity for a page reload to reconnect to the correct progress. |
| `GET /api/status` | Add optional custom-source display metadata; preserve existing backend and capability semantics. |

The browser must not choose a destination path or supply an arbitrary URL for the worker to fetch. Resolve download URLs server-side from the selected GitHub asset. Re-fetch and compare the selected asset identity/metadata before download; if it was removed or replaced, ask the user to reload the selection rather than silently installing something else. Bound release pagination and show a clear message for empty releases, API rate limiting, inaccessible repositories, and missing assets.

Persist a small `custom_install` record after success: repository, release tag/ID, asset ID/name, source link, available digest, and installation timestamp. Keep `backend`, `tag`, and `version` compatible with today's Custom behavior; a fork tag containing an upstream build number must not accidentally enable official-build-only flag assumptions. Keep source metadata separate from capability detection. Manual activation must not make stale download provenance appear freshly verified after files have been changed externally.

## Download, extraction, and validation

### URL and archive boundaries

- Parse URLs structurally. Permit HTTPS public GitHub release paths only; reject userinfo, unexpected ports, local addresses, unsupported schemes, and lookalike hosts. Encode repository/tag/filename components when constructing API requests.
- Validate every redirect against a narrowly defined GitHub release-download host policy, including the actual asset delivery hosts verified at implementation time. Preserve TLS verification and existing applicable transport behavior; do not accept arbitrary redirected hosts.
- Use GitHub's asset size and SHA-256 digest when supplied. Reject short/oversized downloads and digest mismatches. Report missing checksum metadata honestly; a matching checksum does not establish that a publisher's executable is safe.
- Extract into a fresh staging area. Reject path traversal, absolute/drive/UNC paths, platform-invalid names, duplicate destinations, case collisions on Windows, and special-device entries. Constrain both entry count and actual expanded bytes with practical bounds, and handle disk exhaustion.
- Handle internal archive links only after validating that the complete link chain stays inside the extracted package and resolves to a regular file. Preserve or safely materialize required library aliases. Reject escaping, cyclic, or unsupported links instead of silently producing an incomplete build.
- Validate staging, backup, and target paths before every rename or cleanup. Reject an unexpected symlink/junction at the managed destination; do not follow it into an unrelated directory.

### Supported layout

Find one unambiguous directory containing both required executables. Normalize an outer wrapper so those executables end up directly in `llama/custom/bin/`, while retaining their supported relative runtime/data layout, metadata, and license files. Preserve needed nested folders and executable permissions.

Do not pick the first executable found in a package containing several builds. Do not silently discard sibling runtime directories or flatten libraries with identical names. If the layout requires files outside the supported replacement boundary, or cannot be normalized without changing runtime lookup behavior, reject it with manual-setup guidance. Characterize representative archives before implementing the normalization rule.

### Runtime dependencies and validation limits

On 2026-09-07, [Unsloth's CUDA bundle packager](https://github.com/unslothai/llama.cpp/blob/master/scripts/unsloth/package_bundle.py) explicitly documented that CUDA runtime libraries are omitted and expected to come from a PyTorch runtime. It also preserves Unix library links and ships dynamically loaded backend modules. Treat this as a dated observation: inspect the selected release's packaging again when work resumes.

1. Require real executable files for `llama-server` and `llama-cli`; reject known OS/architecture mismatches. Keep benchmark tools optional.
2. Refactor only the necessary validation helpers to accept a staging runtime directory explicitly. Never validate against the old custom directory or temporarily rebind global paths.
3. Check discoverable dependencies, including dynamically loaded ggml modules where supported. Separate **missing**, **checked**, and **unchecked** results. Do not silently inherit the old Custom build's libraries during checks.
4. After the explicit install action, use bounded, non-shell startup/version probes where useful, with the intended launch environment and timeouts. Lookup/extraction alone must not execute downloaded scripts or binaries. Preserve stderr details in logs and show sanitized errors to the client.
5. Known missing dependencies or failed startup probes block replacement and identify the missing runtime or unsupported package as precisely as the platform permits. Offer manual setup guidance and the release link, without installing dependencies automatically.
6. An unavailable inspector or an unverified GPU module must not be reported as fully validated. A successful executable probe can still miss GPU initialization, driver compatibility, model support, and fork-specific flags; report the limitation without claiming that installation ran an inference test.

Do not build a complete dependency resolver or binary compatibility scanner for this feature. Windows dependency diagnostics are a specific validation gap to address proportionately, not a reason to promise exhaustive detection.

## Replacement and recovery sequence

1. Revalidate the selection and replacement acknowledgement. Claim the shared install slot atomically; reject a competing install/cleanup or a running managed process. Always release the slot if worker creation or later work fails.
2. Create a private download directory and sibling staging directory on the destination filesystem. Check available space for the archive and extracted replacement while retaining the existing build. An early space estimate must not replace handling write failures.
3. Download, verify, extract, normalize, and validate entirely in staging. Keep the active directory and config unchanged on failure.
4. Before the first live rename, atomically write a small recovery record identifying this operation, its phase, the known staging/backup paths, whether a previous build existed, and the installation-related config values needed for rollback. Keep it narrowly scoped to this importer.
5. Move the existing `bin` directory to the operation's backup path, then rename the staged directory to `bin`. Do not merge contents or delete an unresolved backup from an earlier operation.
6. Complete activation checks against the final location, then save Custom activation and provenance under the config lock. Preserve the remembered official installation and unrelated settings. Mark the operation committed only once files and configuration agree, then invalidate runtime-health caches.
7. On any failure before commit, restore the prior directory and only the affected installation metadata, preserving unrelated config edits. If there was no previous custom build, remove the failed replacement and restore the prior active backend.
8. After commit, remove the temporary backup and recovery record. A backup-cleanup failure is reported/logged and retried safely; it must not undo a successful committed installation. Clean partial downloads and unused staging in `finally`, while preserving files needed for recovery.
9. On startup, reconcile an unfinished recovery record before allowing launch/install actions: restore the old build for an uncommitted operation, or finish cleanup for a committed one. If recovery cannot complete, retain the backup and show its location and the actionable error.

Account for interruption between each filesystem/configuration step, not just caught Python exceptions. Make recovery repeatable and refuse ambiguous or unexpected paths. Reuse existing install/process locks and lock ordering rather than inventing a second independent busy flag.

The backup covers installation/activation failures and interrupted replacement. It is removed after successful commit; later inference failures do not trigger automatic rollback in this version. The user can explicitly reinstall an earlier release through the same importer.

## Implementation sequence

1. **Recheck fixtures and scope:** inspect representative Unsloth Windows CUDA, Linux, and macOS archive layouts and runtime requirements; define the accepted layout and redirect-host policy using current evidence.
2. **Resolve releases:** implement URL normalization, bounded release/asset lookup, stable selection identity, and API validation with mocked GitHub fixtures.
3. **Build the importer:** implement staged extraction, runtime checks, replacement acknowledgement, metadata persistence, and recovery using focused shared helpers. Keep the official installer behavior covered by existing regressions.
4. **Wire the Custom UI:** add the disclosure, link/release/asset controls, replacement copy, progress reconnection, and source status. Reuse the current manager utilities and theme tokens.
5. **Verify failure behavior and integration:** run the tests below and perform a controlled manual import against a disposable installation. Document native-platform gaps explicitly.
6. **Update documentation when the feature exists:** add a dated entry to `docs/changelog.md`; update Custom setup/troubleshooting guidance and this plan's status. Register any new routes and update both API tables and the endpoint count in `docs/directory.md` / `docs/architecture.html`. Update the canonical script order if a frontend module is added, and record new coverage in `docs/tests.md`.

## Verification and acceptance criteria

Use small synthetic archives and mocked network/probe results for automated tests. Do not download multi-gigabyte release assets or require a GPU in CI.

| Area | Cases that must be covered |
| --- | --- |
| Link/asset lookup | All supported link forms; encoded tags; invalid hosts/schemes/ports; unsupported/private/source links; empty releases; pagination bounds; rate-limit and network errors; removed/changed assets; a new latest release after selection |
| Download integrity | Full transfer, early EOF, size/digest mismatch, missing digest, unexpected redirects, timeout, disk-full failure, and partial-file cleanup |
| Extraction | Flat and wrapped ZIP/TAR packages, supported nested runtime data, safe library aliases, Unix permissions, traversal/absolute paths, Windows collisions, duplicate entries, malicious links, extraction limits, and ambiguous/unsupported layouts |
| Validation | Missing required tool; optional tools absent; wrong platform/architecture; missing runtime; dynamically loaded backend dependency; inspector unavailable; startup failure/timeout; validation never uses old custom libraries |
| Replacement | Fresh install and replacement; acknowledgement required even for manually populated folders; no stale library mixing; models/presets/grammars/official build preserved; file-lock failure; activation/config-write failure; accurate metadata rollback |
| Recovery | Interruption at each recorded phase; no prior custom build; failed restore; cleanup failure after commit; repeated startup recovery; refusal of unexpected paths; retention of the only recovery backup |
| Concurrency | Duplicate requests, worker-start failure, install versus launch/cleanup, slot release on all exits, and shared progress consistency |
| UI | Custom-only visibility; manual activation retained; no automatic asset guess; exact warning and action labels; stale lookup rejection; safe text rendering; empty/error states; success/failure/source status; page reload during import; keyboard and narrow-screen usability |
| Existing behavior | Official install/update/reactivation, manual Custom activation, status reconciliation, and Custom flag-compatibility assumptions |

Extend the owning tests, particularly `tests/backend/test_services.py`, `test_extracted_routes.py`, `test_review_regressions.py`, `tests/frontend/manager_releases_unit.cjs`, and the relevant install scenarios in `flag_sync_smoke.cjs`. A focused custom-release service test module is appropriate if the new service is split out.

Run after implementation, using the project venv for Python:

```powershell
node --check ui/js/manager.js
npm run test:frontend
.venv/Scripts/python.exe -m unittest discover tests -v
```

Also run `node --check` on every other changed JS file. Use `npm test` for the full frontend suite when selecting the final integration checks, avoiding redundant reruns once required checks pass. Backend discovery includes the API documentation synchronization checks.

Keep CI on Linux and Windows as required by the dated exception in `AGENTS.md`; exercise macOS logic with fixtures on those runners and list the remaining native checks. Before considering cross-platform support verified, manually check real executable permissions, library loading, and replacement behavior on the relevant platform. Use a disposable Custom directory and preserve the maintainer's live installation.

Completion means a user can select a supported GitHub package, explicitly replace a custom build, see accurate progress/source information, and retain a recoverable previous installation on pre-commit failure. A package needing unresolved external runtimes must produce useful guidance without automatically installing those dependencies or destroying the old build.
