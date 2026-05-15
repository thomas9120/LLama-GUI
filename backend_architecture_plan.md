# Backend Architecture Plan

Maintainability plan for the completed refactor from a Python backend concentrated in `server.py` to a modular `backend/` package with `server.py` kept as the compatibility entrypoint.

---

## Summary

The backend was refactored in stages, with tests and shared context introduced before splitting files. The goal was not just to make `server.py` smaller, but to reduce hidden global state coupling, make routes testable, preserve optional dependency behavior, and avoid circular imports.

Recommended order:

1. Add a small backend smoke-test harness.
2. Introduce shared state/config/context objects.
3. Add a request/response adapter and dispatch table.
4. Extract route handlers by risk level.
5. Extract non-route subsystems once state ownership is clear.

---

## 1. Prepare Safety Rails First

Before moving code into modules, add lightweight tests around behavior that is easy to break during refactoring.

Suggested coverage:

- CORS origin checks, including localhost, `127.0.0.1`, and active tunnel URL behavior.
- JSON error response shape and HTTP status mapping.
- Path validation and filename sanitization for presets, model downloads, and native file picker purposes.
- State snapshot/update/reset behavior for install, HF download, llama process, and remote tunnel state.
- Route dispatch lookup for known GET/POST/DELETE endpoints.
- A minimal smoke test that can instantiate the handler/context without requiring optional dependencies.

This does not need to be exhaustive. The point is to catch accidental behavior changes while the backend is being split apart.

---

## 2. Introduce Backend Context and State

Do this before creating many modules. Otherwise the refactor only turns one global-heavy file into several global-heavy files.

Create explicit shared objects:

```python
@dataclass(frozen=True)
class AppPaths:
    base_dir: Path
    ui_dir: Path
    models_dir: Path
    presets_dir: Path
    llama_dir: Path
    llama_bin_dir: Path
    llama_grammars_dir: Path


@dataclass
class ServerState:
    process: ProcessState
    install: InstallState
    hf_download: DownloadState
    tunnel: TunnelState
    llama_api_target: AtomicDict


@dataclass
class AppContext:
    paths: AppPaths
    state: ServerState
    config: ServerConfig
```

Use an `AtomicDict` or small typed state classes for state that currently relies on separate globals and locks.

Priority state migrations:

- Install/update progress and `install_in_progress`.
- HF model download state, in-progress flag, and cancel event.
- Remote tunnel process/state/lock.
- llama.cpp subprocess and output buffer.
- Local llama API target host/port.

Keep path and port defaults centralized in a config/constants module, but avoid making runtime state depend on import-time globals when it can be passed through `AppContext`.

---

## 3. Add Request/Response and SSE Adapters

Route functions should not depend directly on the full `SimpleHTTPRequestHandler` API. Add a thin adapter that wraps the current handler.

The adapter should expose:

```python
request.json()
request.query
request.path
request.headers

response.json(data, status=200)
response.error(message, status=400, code=None)
response.text(body, status=200, content_type="text/plain; charset=utf-8")
response.bytes(body, status=200, content_type="application/octet-stream")
response.sse()
```

Standardize API errors as:

```json
{
  "error": "human-readable message",
  "status": 400,
  "code": "optional_machine_readable_code"
}
```

Use `status` for the HTTP status number. Keep `code` available for compatibility cases like HF duplicate downloads, where the frontend may already rely on a string such as `"exists"`.

For SSE, add an `SseWriter` wrapper:

```python
class SseWriter:
    def send(self, data): ...
    def done(self): ...
```

Move chat streaming code to use `SseWriter` before extracting chat routes. This removes the tight coupling between chat logic and `handler.wfile`.

---

## 4. Replace Handler If/Else Routing With Dispatch

Once request/response wrappers exist, replace the long `do_GET`, `do_POST`, and `do_DELETE` chains with a dispatch table.

Example shape:

```python
ROUTES = {
    "GET": {
        "/api/status": handle_status,
        "/api/releases": handle_releases,
        "/api/output": handle_output,
    },
    "POST": {
        "/api/launch": handle_launch,
        "/api/stop": handle_stop,
    },
    "DELETE": {
        "/api/presets/{name}": delete_preset,
    },
}
```

Each route handler should accept:

```python
def handle_status(request, response, ctx):
    ...
```

Keep static file serving, `/assets/app-logo.png`, and `/v1/*` proxy handling explicitly separate from API route dispatch.

Define CORS behavior in one place:

- `/api/*` routes must enforce safe request origins.
- `/v1/*` proxy routes must enforce safe request origins.
- Static UI assets may remain publicly readable from the local server, but this exception should be explicit.
- Access-Control-Allow-Origin should still reflect only allowed origins.

---

## 5. Extract Routes by Risk Level

After the dispatch table is working, extract route groups gradually. Prefer low-state routes first.

Suggested package layout:

```text
backend/
  __init__.py
  app.py              # server construction, context creation, main entry helpers
  config.py           # constants, platform detection, path defaults
  context.py          # AppContext, AppPaths, ServerConfig
  state.py            # AtomicDict and typed shared state classes
  http.py             # request/response adapters, errors, CORS helpers, SSE writer
  routing.py          # dispatch table and route matching
  routes/
    status.py
    models.py
    presets.py
    metrics.py
    hf_download.py
    search.py
    chat.py
    install.py
    process.py
    tunnel.py
    git_update.py
  services/
    llama_manager.py
    process_manager.py
    hf_download.py
    web_search.py
    tunnel.py
    git_update.py
    file_picker.py
    lifecycle.py
```

Avoid naming the package `server/` while the entrypoint is still `server.py`; that creates an unnecessary import-name collision. Either rename the entrypoint first or use a distinct package name like `backend/`.

Extraction order:

1. Low risk: status, models, presets, metrics.
2. Medium risk: HF repo listing/download routes, web search, chat proxy.
3. High risk: process launch/stop/input, install/update, remote tunnel, shutdown/restart.

For each extraction, move only one route group at a time and run the smoke tests before continuing.

---

## 6. Preserve Optional Dependency Behavior

Several features intentionally import dependencies lazily so the server can still start when optional packages are missing.

Keep lazy or guarded imports for:

- `huggingface_hub` in HF model listing/download helpers.
- `ddgs` in web search.
- `tkinter` in the native file picker.

Do not move these to package-level imports unless startup failure is intentional and documented. Route handlers should return a clear API error when an optional dependency is unavailable.

---

## 7. Centralize Lifecycle and Constants

Move hardcoded values into named constants:

```python
GUI_PORT = 5240
LLAMA_PORT = 8080
RESTART_INITIAL_DELAY_SECONDS = 2.5
RESTART_RETRY_INTERVAL_SECONDS = 0.5
RESTART_MAX_RETRIES = 10
BYTES_PER_MB = 1024 * 1024
```

Add a `lifecycle.py` service responsible for coordinated cleanup:

- Stop remote tunnel.
- Stop llama.cpp subprocess.
- Shut down or restart the GUI server.
- Prepare future subsystem cleanup in one place.

`main()`, `/api/shutdown`, `/api/restart`, and app-update restart logic should all call the same lifecycle coordinator instead of duplicating cleanup order.

---

## 8. Implementation Checklist

- Add smoke tests for state, CORS, errors, and route dispatch.
- Create `AtomicDict` and typed backend state containers.
- Create `AppPaths`, `ServerConfig`, and `AppContext`.
- Replace ad hoc JSON errors with `response.error(...)`.
- Add `SseWriter` and migrate chat streaming to it.
- Introduce dispatch routing while handlers still live in the original file.
- Extract low-risk API routes.
- Extract medium-risk API routes.
- Extract process/install/tunnel/lifecycle routes last.
- Preserve lazy imports for optional dependencies.
- Verify the frontend still handles install, launch, chat streaming, HF downloads, web search, tunnel status, and presets.

---

## Acceptance Criteria

- Existing API endpoints keep their URL paths and response semantics unless explicitly documented.
- API errors consistently include `error` and `status`; machine-readable `code` remains available where needed.
- Command launch, stop, output polling, install/update, HF download, chat streaming, web search, presets, metrics, and tunnel controls continue to work from the UI.
- Optional dependency failures are feature-scoped and do not prevent backend startup.
- Route handlers can be tested without starting a real HTTP server where practical.
- Shared mutable state is owned by context/state objects instead of scattered module globals.
