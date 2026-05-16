# Bug Tracker

Known bugs and issues that don't affect core functionality but should be addressed.

---

## 1. Noisy traceback on Cloudflare tunnel stop

**Status:** Open
**Severity:** Low (cosmetic log noise, no functional impact)
**Area:** Backend (`server.py`, `backend/http.py`, `backend/routes/install.py`)

### Description

When stopping a Cloudflare tunnel from the UI, the Python terminal prints a full `ConnectionAbortedError: [WinError 10053]` traceback — twice. The server continues working normally afterward.

### Steps to Reproduce

1. Start a Cloudflare tunnel from the API tab
2. Let it run for a few seconds (so the frontend has pending polls in flight)
3. Stop the tunnel from the UI
4. Observe the terminal output

### What Happens

The frontend periodically polls `/api/releases` (the install tab's GitHub release fetcher). When the tunnel is stopped, the browser aborts in-flight requests client-side. The server is mid-response — writing JSON at `http.py:83` or headers at `http.py:82` — when the underlying socket is already closed. Python's `socketserver` catches the broken pipe and logs the full traceback.

It happens twice because the `get_releases` handler (`install.py:22`) tries to write the JSON response, hits `ConnectionAbortedError`, falls into the `except` block at line 23, tries to send an error response via `response.error()`, and *that* also fails because the socket is dead — producing a second identical traceback.

On Linux this would surface as `BrokenPipeError` instead. It's a client-disconnect-during-response scenario — no state corruption, no resource leak.

### Proposed Fix

Catch `ConnectionAbortedError` and `BrokenPipeError` in `Response.json()` or in the request handler base class so broken-pipe responses are silently swallowed rather than dumped to the terminal.
