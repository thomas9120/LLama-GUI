# Diff Review — Custom Models Folder

Review of the uncommitted custom-models-folder work. All five findings were verified and fixed on 2026-08-13.

## 1. Successful folder save can wipe launch state

`ui/js/manager.js` — `persistModelsDir`

POST `/api/models-dir` can succeed, then `checkStatus()` / `refreshModels()` fail (or lose a race). Catch does:

```javascript
core.setModelDirInfo(null);
```

The folder **is** saved. Preview/launch then fail with “Models folder status is not available yet.”

Worse race: `checkStatus()` bails on a stale `statusRequestId` and returns `null`. Then `checkStatus() || latestStatus` can compare against **old** status, throw, and wipe the new root.

**Fix:** After a successful POST, keep `postedInfo` (or latest status). Only `setModelDirInfo(null)` if the POST itself failed. Treat a stale status read as “use `postedInfo` / `latestStatus`”, not as failure.

## 2. Stale `refreshModels()` looks like success

`ui/js/manager.js` — `refreshModels` + `persistModelsDir`

```javascript
if (requestId !== refreshModelsRequestId) return;  // undefined
// ...
if (await refreshModels() === false) throw ...
```

`undefined !== false`, so an overlapped refresh makes persist toast success and return `true` without this call updating the list.

**Fix:** `return false` on stale (or return `{ok, stale}`). Persist should wait for **this** refresh, or re-read after the winner finishes.

## 3. Restart readiness probe is now `/api/models` 409

`ui/js/manager.js` — `waitForServerReady`  
`backend/routes/models.py` — `list_models`

`/api/models` now 409s when a custom root is missing/unreadable. Restart still does:

```javascript
await fetchJson("/api/models");
```

GUI is up; probe treats 409 as “not ready” for 30s, then “Server did not become ready.”

**Fix:** Probe `/api/status` (always 200). Or treat HTTP 409 from `/api/models` as ready.

Same 409 makes `benchmark-ui.js` `loadModelsForSelect()` swallow the error and show an empty list (looks like “no models”). Surface the folder error there too.

## 4. “Open llama.cpp folder” no longer creates the directory

`backend/routes/lifecycle.py` — `post_open_folder`

Old code: `target.mkdir(parents=True, exist_ok=True)` for both folders.  
New: llama path is opened as-is. Missing `llama/` → native open fails.

The llama test mkdirs first, so it doesn’t catch this.

**Fix:** `ctx.paths.llama.mkdir(parents=True, exist_ok=True)` before open. Leave custom model roots fail-closed (no mkdir).

## 5. Status polls erase the folder-change error

`ui/js/manager.js` — `checkStatus`

```javascript
modelDirOperationError = "";
applyModelDirInfo(status);
```

Any later `/api/status` (install poll, header refresh) clears the banner from (1) or a failed Change/Reset.

**Fix:** Don’t clear `modelDirOperationError` here. Clear it only on a successful persist, or when status matches the operation you just attempted.

## Not errors

- Mixed `D:\My Models/vendor/...` separators (intentional, tested)
- WikiText staying under `ctx.paths.models`
- Default still emitting `-m models/<id>`
- Download lock vs folder change
