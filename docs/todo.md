# TODO

## Model unload after idle (`--sleep-idle-seconds`)

**Goal:** let the user unload a resident model after N seconds of inactivity
(e.g. 4 hours), with automatic reload on the next request.

**Approach:** wrap the upstream llama.cpp feature — `--sleep-idle-seconds`
(PR ggml-org/llama.cpp#18228, merged 2025-12-21). After N seconds without
queued inference tasks the server frees the model/KV ("sleep"); the next
inference request blocks, reloads the model, then serves. `/health` and
`/props` stay answerable during sleep; `/props` exposes `is_sleeping`.

### Known landmine (drives phase 2)

The idle timer resets on **any queued task**. llama-server's `GET /metrics`
and `GET /slots` each enqueue a `METRICS` task, so they reset the timer and
also wake a sleeping server. The GUI scrapes `/api/llama/metrics` every 3s
while a server runs (`app.js` `pollStats`, `/slots` fallback for KV). With
the bare flag, sleep would never trigger — the GUI must stop scraping when
idle.

Note `--timeout` (existing flag) is unrelated: server read/write timeout.

### Phase 1 — Flag definition

- [ ] Verify minimum upstream build: run
      `llama-server --help | grep sleep-idle` against an installed release;
      pin the first release tag containing it.
- [ ] Add to `FLAGS` in `ui/js/flags/definitions.js` (server category, near
      `timeout`): `id: "sleep_idle_seconds"`, `flag: "--sleep-idle-seconds"`,
      `type: "int"`, `tool: "server"`, `default: -1`, `min: -1`. Desc:
      unloads model after N idle seconds, next request reloads it, `-1`
      disabled, note minimum build. `-1` default is omitted by existing
      `shouldOmitFlagValue`, so unchanged launches emit nothing.
- [ ] Run `npm run test:flag-definitions`.
- [ ] No Quick Launch surface initially — Configure rendering is automatic.

### Phase 2 — Sleep-aware stats polling (required, else feature never fires)

- [ ] Backend: expose `is_sleeping`. Extend `GET /api/llama/health`
      (`backend/routes/process.py` → `process_manager.get_llama_health`) to
      also read llama-server `/props` (sleep-safe, enqueues no task) and add
      `is_sleeping` to the response. Best-effort: default `false` when
      `/props` is unavailable (old builds, external servers).
- [ ] Frontend (`app.js` `pollStats`): when `sleep_idle_seconds > 0`
      (read via `flagCore`), track last GUI chat activity; after idle
      exceeds the threshold stop scraping `/metrics` + `/slots` and poll only
      the sleep-safe health/status. Resume scraping on next chat message.
- [ ] While `is_sleeping` is true, show a "Sleeping" state in the stats bar
      instead of stale numbers.
- [ ] Run `npm run test:frontend`; extend a frontend unit test for the
      polling-cutoff logic if one fits the existing suites.

### Phase 3 — Chat while sleeping

- [ ] The first request after sleep blocks during model reload. Check
      `backend/routes/chat.py` proxy (`urlopen(..., timeout=300)`): a large
      model reloading from slow storage may exceed 300s before the first
      byte. Decide: raise the timeout for the connect/first-byte phase, or
      surface a "model reloading" hint rather than a raw timeout.

### Phase 4 — Docs & verify

- [ ] `docs/changelog.md` entry.
- [ ] Manual test: launch with ~30s idle value, confirm "entering sleeping
      state" in the output log (i.e. GUI polling did not block it), send a
      chat message, confirm wake + normal response, confirm stats resume.
- [ ] Confirm `docs/directory.md` needs no route-table change (phase 2 only
      extends an existing endpoint's payload).

### Out of scope / deferred

- GUI-side watchdog that *stops* the subprocess instead of sleeping. Only
  worth it if "process must actually exit" is required (sleep keeps the
  process alive and may retain the CUDA context — upstream issue #25570),
  or for builds older than the flag. Would need backend thread + state +
  UI, and only sees GUI-proxied traffic.
- Version-gating the flag control by installed tag (`/api/status` already
  returns `version`); start with the desc note and let llama-server stderr
  explain unknown flags on old builds.

### Behavior notes (for UI copy / changelog)

- Sleep clears the KV cache; the first message after wake reprocesses the
  full prompt (slower first response).
- Server-only: no effect on `llama-cli` / benchmark tools.
- Model Switcher stop/switch still works; the process stays alive asleep.
- Direct traffic to port 8080 bypassing the GUI resets the upstream timer
  via real tasks, but the GUI's polling cutoff keys on GUI activity only —
  documented limitation.
