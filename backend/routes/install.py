"""Routes for llama.cpp install/update management."""

import threading
import urllib.parse

from ..http import sanitize_error
from ..services import llama_manager
from ..services import process_manager


RELEASE_RESPONSE_LIMIT = 30


def _claim_install_slot(ctx):
    """Atomically keep installs and llama.cpp launches mutually exclusive."""
    return process_manager.claim_install_slot(ctx)


def get_releases(request, response, ctx):
    try:
        repo_api = None
        query = urllib.parse.parse_qs(request.query or "")
        backend = (query.get("backend") or [""])[0].strip()
        if backend == "custom":
            response.json([])
            return
        if backend:
            spec = ctx.services.backend_specs.get(backend)
            if spec is not None:
                repo_api = llama_manager.resolve_repo_api(spec, ctx)
        releases = llama_manager.get_releases(ctx, repo_api)
        result = []
        for r in releases[:RELEASE_RESPONSE_LIMIT]:
            result.append(
                {
                    "tag": r["tag_name"],
                    "name": r.get("name", r["tag_name"]),
                    "published": r["published_at"],
                    "assets": [a["name"] for a in r["assets"]],
                }
            )
        response.json(result)
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)


def get_download_progress(request, response, ctx):
    response.json(llama_manager.get_download_progress_snapshot(ctx))


def start_install(request, response, ctx):
    body = request.body or {}
    tag = body.get("tag")
    backend = body.get("backend")
    if not tag or not backend:
        response.error("tag and backend required", 400)
        return
    if backend == "custom":
        response.error("Use /api/activate-custom to set up the custom backend", 400)
        return
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported backend: {backend}", 400)
        return
    claim_error = _claim_install_slot(ctx)
    if claim_error is not None:
        response.error(*claim_error)
        return

    def _install(tag, backend):
        try:
            llama_manager.install_release(ctx, tag, backend, ctx.services.backend_specs)
        finally:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False

    threading.Thread(target=_install, args=(tag, backend), daemon=True).start()
    response.json({"status": "started"})


def start_update(request, response, ctx):
    cfg = ctx.services.load_config()
    tag = cfg.get("tag")
    backend = cfg.get("backend")
    if not tag or not backend:
        response.error("Nothing installed to update", 400)
        return
    if backend == "custom":
        response.error("Cannot auto-update a custom backend installation", 400)
        return
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported configured backend: {backend}", 400)
        return
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    # Cheap early reject so a duplicate request fails fast instead of spending
    # a GitHub round trip (and rate-limit quota) only to be refused below.
    # This read is advisory; the authoritative check-and-set is under the lock.
    if ctx.state.install_in_progress:
        response.error("Installation already in progress", 409)
        return

    # The release lookup runs before the install slot is claimed: holding
    # install_in_progress across a slow network call would make unrelated
    # requests fail with a 409 for the whole duration of the lookup.
    try:
        backend_spec = ctx.services.backend_specs[backend]
        repo_api = llama_manager.resolve_repo_api(backend_spec, ctx)
        releases = llama_manager.get_releases(ctx, repo_api)
        latest = releases[0]["tag_name"] if releases else None
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)
        return

    if not latest or latest == tag:
        response.json({"status": "already_latest"})
        return

    claim_error = _claim_install_slot(ctx)
    if claim_error is not None:
        response.error(*claim_error)
        return

    def _update(latest_tag, backend_name):
        try:
            llama_manager.install_release(
                ctx, latest_tag, backend_name, ctx.services.backend_specs
            )
        finally:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False

    threading.Thread(target=_update, args=(latest, backend), daemon=True).start()
    response.json({"status": "started", "from": tag, "to": latest})


def activate_custom(request, response, ctx):
    try:
        if process_manager.is_process_running(ctx):
            response.error("Stop running process first", 400)
            return
        result = llama_manager.activate_custom_backend(ctx)
        response.json(result)
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)
