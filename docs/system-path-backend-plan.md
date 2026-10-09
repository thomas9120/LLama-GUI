# Implementation plan: System (PATH) llama.cpp backend

Source: [issue #399](https://github.com/thomas9120/LLama-GUI/issues/399)  
Prepared: 2026-10-08  
Repository baseline: `6543038`  
Status: proposed implementation; no runtime changes have been made.

## Goal

Let users activate the llama.cpp tools already available on the GUI process's
`PATH`. Llama GUI will construct launch arguments, start and stop its own child
processes, and provide the existing Chat, API, Benchmarking, and Monitor features.
The user's system package manager will own llama.cpp installation and updates.

This replaces the issue author's workaround of symlinking system executables into
`llama/custom/bin/`. It is particularly useful for NixOS packages and wrappers
that supply their own runtime dependencies, and also applies to other system
installations.

## Proposed behavior and scope

- Add backend ID `system`, displayed as **System (PATH)**, on supported platforms.
  Keep it selectable when tools are missing so activation can explain the problem.
- Require an executable `llama-server` for activation. Treat `llama-cli`,
  `llama-bench`, `llama-perplexity`, utility tools, and `llama-fit-params` as
  independently available features. Existing official and Custom backend
  requirements remain unchanged.
- Use the PATH inherited by the Python GUI process. Resolve each tool separately;
  tools need not share one directory. Display the paths used for discovery.
- Launch the discovered absolute path with the normal GUI-generated arguments.
  Preserve symlink and wrapper entry points rather than replacing them with their
  final targets. Use an argument list and the existing subprocess implementation.
- Resolve again before a launch or probe. Package updates can replace a symlink
  target while the GUI is open. A running process continues until the normal stop
  action; a later launch uses the then-current tool.
- Preserve the inherited environment for System, then merge the already-supported
  per-launch `LLAMA_`/`GGML_` overrides. Do not prepend repository binary or library
  directories for this backend.
- Disable release selection, GUI binary updates, and Repair for System. A failed
  activation leaves the current backend active. Missing System tools never fall
  back to official or Custom binaries.
- Keep the existing model root, presets, bundled chat templates, subprocess
  working directory, authentication, and process lifecycle. Grammar files remain
  user-selected paths; there is no package-data-directory discovery in this scope.

This feature does not install system packages, modify PATH, source shell startup
files, configure Nix/CUDA, or connect to an already-running server. The existing
external-server feature continues to handle that last case. No new runtime
dependency or general provider framework is needed.

## Existing foundations and changes needed

| Area | Current behavior | Required change |
|------|------------------|-----------------|
| `backend/services/llama_manager.py` | Backend specs, folder selection, Custom activation, packaged runtime checks, official-install metadata | System classification, discovery/probes, activation, and correct preservation of the official installation |
| `backend/app.py` and `backend/context.py` | `find_tool_executable()` returns a path inside one selected installation folder | Delegate to shared discovery; represent an unavailable System tool explicitly; register the activation route |
| `backend/services/process_manager.py` | Preflight and launch share validation; environment prepends a selected bin directory; the estimator locates `llama-fit-params` separately | Use System discovery/environment for every subprocess and validate the executable actually being invoked |
| `backend/routes/status.py` | Installation readiness requires CLI and server; tool availability is reported as booleans | Apply System's server requirement and add discovered paths/build information |
| `backend/routes/install.py` | Custom activation has install/process interlocks; other actions assume a downloadable backend | Add System activation and reject inappropriate install/update/release operations |
| `backend/routes/lifecycle.py` | Open Folder creates an application-owned installation directory | Give System a read-only folder-opening policy |
| `ui/js/manager/manager-backends.js`, `ui/js/manager/manager-install.js`, and `ui/js/manager/manager-status.js` | Backend selection, release fetching, activation, and build-tag propagation | System controls, status, switching, and build information |
| `ui/index.html`, `ui/js/quick-launch-ui.js`, and `ui/js/flag-core.js` | Setup markup, launch readiness, and shared argument generation | System guidance, per-tool readiness, and correct build gates |

Use the existing service/context injection and focused frontend namespaces.
Keep shared flag state authoritative across Configure, Quick Launch, Chat, and
command preview. Touch other consumers only where a demonstrated assumption about
folders, availability, or build tags requires it.

## Stage 1: Backend classification and executable discovery

**Outcome:** one resolver finds the selected backend's tools without changing
existing official/Custom behavior.

1. Add System to `build_backend_specs()` in `backend/services/llama_manager.py`.
   Keep `CUSTOM_BACKEND_SPECS` limited to its two real folder slots; startup must
   not create a System bin/grammar directory.
2. Add narrow helpers for System detection and for identifying installations
   managed outside the GUI. Use them where existing code assumes that every
   non-Custom backend is an official installation. Keep Custom folder behavior
   separate from System PATH behavior.
3. Introduce shared tool resolution in the owning backend service. For System,
   use `shutil.which()` on a known tool filename, make the returned path absolute
   without dereferencing its symlinks, and check file/executable availability.
   Search the inherited PATH only, including its normal precedence and relative
   entries; use platform-aware executable naming. Do not expand the search into
   other repository installations or launch a shell to perform discovery.
4. Restrict discovery inputs to known llama.cpp tools. Include `llama-fit-params`
   as an internal discovery target without adding it to the public launch-tool
   allowlist. Do not permit arbitrary executable names through the API.
5. Make `find_tool_executable()` delegate to that resolver. Use `None` for an
   unavailable System tool, update the `BackendServices` callable annotation,
   and explicitly guard all consumers before path operations. Preserve the
   existing folder-path results for official and Custom installations.
6. Remove System calls into folder-only helpers. System has no single bin
   directory: runtime enumeration and setup should not scan or create PATH
   directories. A guard in the folder helper can catch accidental misuse.

**Verification:** add focused discovery cases under `tests/backend/`, covering
PATH precedence, tools in different directories, missing tools despite local
official binaries, spaces in paths, executable permissions, symlinks/wrappers,
Windows `.exe` lookup, and existing official/Custom resolution. Use fixtures for
platform-specific lookup rather than relying on the host's installed llama.cpp.

**Exit criterion:** a missing System tool is explicit, and choosing System cannot
select a tool from a different backend by fallback.

## Stage 2: Runtime probes, environment, and process integration

**Depends on:** Stage 1.  
**Outcome:** the existing launch pipeline can run system tools and wrappers.

1. Add a System branch to `_build_process_env()` that copies the inherited
   environment without injecting local binary/library paths. Apply existing
   validated per-launch overrides afterward. Keep official/Custom environment
   construction unchanged.
2. Validate System executables with a bounded, model-free `--version` subprocess
   using the discovered entry point, inherited runtime environment, existing
   window-hiding conventions, and a short timeout such as five seconds. Parse
   stdout and stderr for recognized build formats; successful execution with an
   unknown build format is distinct from a failure to execute.
3. Use that execution check for System runtime health instead of requiring nearby
   DLLs, `.so` files, or `@rpath` libraries. Do not run `ldd`/`otool` against a Nix
   wrapper and interpret a script-inspection failure as a broken installation.
   A successful version probe establishes that the entry point starts; it does
   not establish model loading or GPU compatibility.
4. Cache probe results under the existing runtime-health lock. Include the
   executable path and file/symlink identity in the System cache key, retain a
   bounded TTL, and invalidate on activation or discovery changes. Ordinary
   status polls should reuse results rather than spawn probes on every request.
   Avoid holding process/config locks during subprocess execution.
5. Integrate missing-tool errors and System probes into preflight and launch.
   Resolve and validate the same entry point that is passed to `Popen`; if it
   disappears between validation and execution, return the normal logged,
   sanitized launch failure. Preserve install/process interlocks, runtime
   generations, output capture, health polling, and Windows process groups.
6. Route `_fit_params_executable()` through shared discovery. In memory
   estimation, validate `llama-fit-params` itself for System; the current code
   locates the estimator separately but validates the requested CLI/server tool.
   Missing estimation support must not block server launches.
7. Review `get_buffer_types()`, which currently chooses CLI. For System, prefer
   an available supported CLI/server probe target, using server when CLI is
   absent. Preserve the existing unavailable/error behavior if the build does
   not support the probe rather than implying that GPU capability was verified.

**Verification:** cover preserved PATH/library variables, wrapper execution,
known/unknown builds, probe failures/timeouts, cache invalidation, missing
estimator, server-only buffer discovery, unchanged argument/environment payloads,
and existing start/stop behavior. Extend
`tests/backend/test_process_environment.py` and relevant service tests.

**Exit criterion:** server preflight and launch use the system entry point and
environment, with recoverable errors and no packaged-library requirement.

## Stage 3: Activation, persistence, status, and switching

**Depends on:** Stages 1-2.  
**Outcome:** System can be activated, restored after restart, and switched safely.

1. Add proposed route `POST /api/activate-system` in `backend/routes/install.py`
   and register it in `backend/app.py`. It accepts no client-supplied executable
   path. Reuse the Custom activation install-slot claim/release pattern to reject
   activation during an install or while a GUI-managed process is running.
2. Discover tools and require the System server execution probe to succeed before
   changing configuration. Return discovered paths, found/missing tool lists,
   normalized build tags, and actionable failure information. Validate request
   shape and log unexpected errors before returning `sanitize_error()` output.
3. Persist the selection under `config_lock`, merging with the latest config so
   model-root/external-target settings survive. A simple marker such as
   `backend: "system"`, `tag: "system"`, `version: "system"` is sufficient for
   selection; discovered paths and build tags come from current discovery/cache,
   not persisted Nix-store paths. Configuration is unchanged on failed probing.
4. Preserve `official_install` when leaving an official build. Update both Custom
   activation and `get_official_install_status()` so System is never recorded as
   the official installation. Switching System -> Custom -> official must retain
   the correct official backend/tag. Reuse Activate Existing for the return path.
5. Extend `/api/status` additively. Retain `executables` booleans and existing
   fields. Mark the available-backend entry with `system_path: true`, expose
   per-tool discovered paths/build tags and probe state, and calculate System
   readiness from its server rather than both CLI and server. Keep selected
   backend configuration separate from discovered version information.
6. Report a removed/broken System server as unavailable/stale with PATH guidance.
   Do not clear the user's selection or silently select another backend. On GUI
   restart, rediscover with that process's inherited environment.
7. Explicitly reject System in install, repair-via-install, update, and
   activate-existing official requests before downloads or config mutation.
   Return an empty release list for System without a release lookup. Verify
   official catalog refresh does not turn System into a download target.
8. Keep cleanup limited to the existing application-owned directories. Preserve
   the active System selection while clearing removed official-install metadata.
   For System Open Folder, open the discovered server's containing directory
   without creating it; report unavailable if the server cannot be found.
9. Update the Route Modules table and endpoint count in `docs/directory.md` in
   the same implementation change. This plan adds one exact route; the current
   baseline's 50 endpoints would become 51 if no other routes change meanwhile.

**Verification:** successful/failed activation, running/install rejection,
restart restoration, server-only status, direct misuse of install/update routes,
official/System/Custom round trips, config merge preservation, cleanup, and
read-only folder opening. Extend `tests/backend/test_custom_slots.py` and
`tests/backend/test_extracted_routes.py`; put System-specific cases in a focused
`test_system_backend.py` file under the existing backend tests directory.

**Exit criterion:** a System selection survives restart and cleanup, and users
can return to their previous installation without downloading it again.

## Stage 4: Frontend controls, readiness, and build compatibility

**Depends on:** Stage 3.  
**Outcome:** the user can discover, activate, and understand System from the GUI.

1. Render the backend from backend-provided metadata in the existing Manager
   package. Selecting it shows **Activate System**, hides release selection,
   and explains that the OS package manager owns installation and updates.
   Add minimal setup markup in `ui/index.html`; keep the current script order.
2. Display each discovered tool/path and availability using `textContent`.
   Show server as required for System and the other tools as feature-specific.
   Retain both CLI/server requirements in existing official/Custom views.
3. Distinguish the pending dropdown choice from the active backend. Route System
   activation to its endpoint, retain duplicate-action guards, refresh status
   afterward, and show errors near the activation controls. Polling must not
   reset the user's pending selection.
4. Disable System update/repair and suppress release fetching, including forced
   refresh paths. Selecting an official target while System is active should
   offer Activate Existing where appropriate. Derive this from accepted status.
5. Adjust Quick Launch and other affected readiness checks to consider the
   requested executable. A missing CLI must leave server/Chat usable. Missing
   benchmark/perplexity tools or the estimator should produce feature-specific
   guidance, with backend launch validation remaining authoritative.
6. Feed detected build tags into the existing shared flag-core compatibility
   gates. PATH can resolve CLI and server from different builds; use the tag
   for the tool whose arguments are being generated, including tool changes
   and benchmark source configurations. Extend the existing tag mechanism
   narrowly rather than creating per-tab flag state. Unknown build formats
   retain the existing conservative gate behavior and an explicit unknown
   version display; do not invent a release tag from a package version.
7. Keep command preview on the existing shared argument builder. The System
   details show the actual executable path; a new command builder is unnecessary.
   Update folder/remove action labels and explanations to match Stage 3.
8. Explain discovery failures concretely: **llama-server was not found on the
   PATH inherited by Llama GUI. Start the GUI from the environment where it is
   available, or restart the GUI after changing its launch environment.**
   Avoid displaying the entire environment or offering automatic shell edits.

**Verification:** extend `tests/frontend/manager_releases_unit.cjs`, relevant
flag-core/launch/benchmark tests, and `tests/frontend/flag_sync_smoke.cjs`.
Check activation, pending selection, disabled actions, server-only readiness,
tool-specific build gates, safe path rendering, and official return activation.
Run `node --check` on every changed JS file and `npm run test:frontend` for DOM
wiring/shared-state changes.

**Exit criterion:** a server-only System installation is usable through the
normal GUI, and unavailable optional features have clear, localized errors.

## Stage 5: Regression coverage and release checks

**Depends on:** Stages 1-4; add focused tests alongside their owning stages.  
**Outcome:** the whole feature and existing backends pass the release checks.

- Exercise three representative System layouts: server only, a complete set of
  tools, and wrapper/symlink entry points. Include a broken server, different
  CLI/server builds, an unknown version format, and a changed package target.
- Keep host llama.cpp installations out of deterministic unit tests. Use
  temporary files, mocked subprocess responses, and environment fixtures.
- Update `tests/frontend/llama_flags_supported_unit.cjs` so selecting System
  checks PATH tools rather than local downloaded binaries first. Cover selection
  in `tests/frontend/llama_flags_runner_unit.cjs`. Preserve explicit binary
  directory precedence and the required pinned-build CI checks. The full flag
  comparison still needs both CLI and server; server-only runtime support must
  not weaken that test's existing contract.
- Recheck official and both Custom activation, launch environment, missing-tool
  errors, cleanup, and switching. Reuse the existing suites rather than adding
  another process manager or browser harness.
- Run the full backend suite in the project venv, the frontend suite, and docs
  link/route-sync checks once the staged work is integrated.

```powershell
.venv/Scripts/python.exe -m unittest discover tests -v
npm test
.venv/Scripts/python.exe -m unittest tests.backend.test_docs_links tests.backend.test_docs_sync -v
```

On Unix, use `.venv/bin/python` for the Python commands. Follow [the test
reference](tests.md) for focused commands during each stage. Keep CI on its
existing Linux and Windows runners; cover macOS path/probe behavior with fixtures.

**Exit criterion:** automated checks pass without requiring a system llama.cpp
installation, GPU, or native macOS runner, and CI's pinned binary check remains
strict.

## Stage 6: User documentation and native validation

**Depends on:** Stage 5.  
**Outcome:** the feature is documented and its real environment behavior is known.

1. Update `docs/directory.md` with System selection/discovery, runtime validation,
   status metadata, and the final route contract. Update `docs/tests.md` for new
   coverage, and `docs/troubleshooting.md` for inherited PATH, restart, unknown
   build tags, and package-manager-owned updates.
2. Document terminal-versus-desktop/Pinokio environment differences. Keep startup
   entry points and runtime dependencies unchanged. If implementation requires
   launcher/startup changes, inspect the companion launcher documented in the
   [project reference](directory.md#companion-repositories) before making them.
3. Validate on NixOS with an actual system package/wrapper: activate, load a model,
   send a Chat message, inspect Monitor, stop, restart, and switch back. Test a
   package/profile update to confirm later launches rediscover the entry point.
4. Smoke-test a conventional Linux installation, Windows PATH executables, and
   macOS package-manager/desktop startup when those environments are available.
   Check optional tools only where installed; a missing estimator is an expected
   unavailable feature. Record which native checks were actually run.

**Exit criterion:** docs describe the implemented behavior, and native NixOS
validation establishes that wrappers and real model/GPU loading work. If that
environment is unavailable, explicitly record the remaining native check rather
than claiming fixtures establish NixOS/CUDA compatibility.

## Effort estimate and completion criteria

This is a small-to-medium implementation. Discovery is straightforward; runtime
environment assumptions, optional tools, build gates, and switching account for
most of the integration work.

- Stages 1-2: approximately one developer day.
- Stage 3: approximately half to one day.
- Stage 4: approximately one day.
- Stages 5-6: approximately half to two days, depending on native environments.

Allow roughly **3-5 developer days** for a reviewed implementation by someone
familiar with this repo. Native NixOS/macOS availability can extend elapsed time.
Expect around **10-14 production files** plus focused tests and documentation;
keep the final diff driven by the concrete consumers listed above. A minimal
server-launch prototype could take 1-2 days but would not complete this plan.

The feature is complete when System activates without copied/symlinked repository
binaries, normal server/Chat flows work with its inherited environment, missing
optional tools affect only their features, official/Custom switching remains
correct, system files are never modified by maintenance actions, automated checks
pass, and native validation results or remaining limitations are documented.
