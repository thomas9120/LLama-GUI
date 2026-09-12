# Contributing to Llama GUI

One page to get you from a fresh clone to a running app and a green test
suite. When something here refers to project rules, the answer lives in
[`AGENTS.md`](AGENTS.md) — it is written for AI coding agents, but every rule
in it applies to human contributors too. Read it next.

## Prerequisites

- **Python 3.9 or newer** (3.9 is the CI floor)
- **Node.js 18 or newer** — runs the frontend test suites and Playwright
- **git**
- Windows, Linux, or macOS

## Setup

```bash
git clone https://github.com/thomas9120/LLama-GUI.git
cd LLama-GUI
python -m venv .venv
npm ci
npx playwright install chromium
```

Then install the Python dependencies **into the venv**:

```bash
# Windows
.venv\Scripts\python.exe -m pip install -r requirements.txt
# Linux / macOS
.venv/bin/python -m pip install -r requirements.txt
```

> **Always use the venv Python.** System Python lacks `huggingface_hub` and
> the other runtime dependencies, so tests fail with misleading import
> errors deep inside unrelated modules. Every Python command below shows the
> full venv path, so you never have to remember activation.

## Run the app

```bash
# Windows
.venv\Scripts\python.exe server.py
# Linux / macOS
.venv/bin/python server.py
```

Open <http://127.0.0.1:5240>. The GUI itself is now running; to run a model,
download a `llama.cpp` build in the **Install** tab and a `.gguf` model
in-app (see [Getting Models](README.md#getting-models) in the README).

## The dev loop

- **Frontend (`ui/`)**: save the file, refresh the browser. All HTML is
  served with `Cache-Control: no-store`, so there is nothing to rebuild or
  restart. There is no bundler: `ui/index.html` loads the scripts as ordered
  global `<script>` tags that attach to `window.LlamaGui` — never reorder
  them; a test enforces the order.
- **Backend (`backend/`)**: stop the server (`Ctrl+C`) and start it again.

- **Adding a module** rather than editing one? See
  [Adding a new frontend module](#adding-a-new-frontend-module) below for
  the skeleton and placement rules.

## Adding a new frontend module

There is no bundler and no import system: `ui/index.html` loads every
script as an ordered global `<script>` tag, and modules attach to
`window.LlamaGui`. A new module is three edits plus a test run:

1. **Create the module** (for example `my-module.js` under `ui/js/`) from
   the skeleton below. Every file starts with a role header comment;
   shared utilities (`showToast`, `fetchJson`, `flagCore`, …) arrive via
   `configure()` from `app.js` — never reach for them as globals.
2. **Add the `<script>` tag in `ui/index.html`** after the module's
   dependencies and before its consumers. Never reorder existing tags; a
   test enforces the order.
3. **Wire it in `ui/js/app.js`**: call `myModule.configure({ ... })` next
   to the other `configure()` calls, and `myModule.init()` (if the module
   has DOM wiring) in the startup sequence. No new top-level globals in
   `app.js`.
4. **Document it**: add a row to the Script Loading Order list and the
   Frontend Module Reference in
   [`docs/directory.md`](docs/directory.md).

```js
// My module: one-line role description.
(function () {
    "use strict";

    const root = window.LlamaGui = window.LlamaGui || {};

    let shared = null; // injected by app.js

    function configure(deps) {
        // app.js injects shared utilities here: { showToast, fetchJson, ... }
        shared = deps;
    }

    function init() {
        // One-time DOM wiring; runs from app.js after configure().
    }

    root.myModule = { configure, init };
})();
```

```bash
node --check ui/js/my-module.js      # syntax
npm run test:frontend:modules        # module/namespace contract
npm run test:frontend                # when DOM wiring is touched
```

## Tests

```bash
# Backend — 800+ tests, a few seconds
.venv\Scripts\python.exe -m unittest discover tests -v

# Frontend — syntax check, unit suites, flag checks, Playwright smoke tests
npm test
```

- Run the **focused** check for your change type: the
  [Verification table in AGENTS.md](AGENTS.md#verification) maps every kind
  of edit to its required check, and [`docs/tests.md`](docs/tests.md)
  catalogs what each suite covers. A single backend test file runs like
  `.venv\Scripts\python.exe -m unittest tests.backend.test_docs_sync -v`.
- The Playwright smoke tests serve `ui/` through `python -m http.server`;
  if `python` is not on your PATH, point the `PYTHON` environment variable
  at an interpreter.
- **Playwright is dev/CI-only.** Never add it to `requirements.txt`, launch
  scripts, or the Pinokio setup — runtime installs stay Python-only.

## Before you open a PR

1. Run the checks for your change type (the AGENTS.md Verification table);
   when in doubt, run both full suites above.
2. Keep diffs minimal and fix root causes — start in the owning module
   (AGENTS.md, "Workflow").
3. CI runs the backend suite on Ubuntu (Python 3.9/3.12/3.13) and Windows
   (3.12/3.13), and the frontend suite on Ubuntu (3.13). macOS runners are
   deliberately excluded — see the dated exception in AGENTS.md.
4. Docs count as code: adding or removing backend routes must update the
   Route Modules table in `docs/directory.md` (`test_docs_sync.py` fails
   otherwise), and file references in docs must point at real files
   (`test_docs_links.py`).

## Reading order

1. [`README.md`](README.md) — what the app is; user-level install and features.
2. This file.
3. [`AGENTS.md`](AGENTS.md) — the project rulebook: ownership, pitfalls, and
   the change-type → required-test table. Written for agents, meant for you.
4. [`docs/directory.md`](docs/directory.md) — the reference manual: read the
   Architecture section first, then module and feature sections on demand.
5. [`docs/tests.md`](docs/tests.md) — the test catalog and commands.

On demand: [`docs/maintenance.md`](docs/maintenance.md) (releases and
dependencies), [`docs/upstream-changes.md`](docs/upstream-changes.md)
(llama.cpp fork deltas), [`docs/security.md`](docs/security.md),
[`docs/troubleshooting.md`](docs/troubleshooting.md), and
[`docs/gpu-monitoring.md`](docs/gpu-monitoring.md).
