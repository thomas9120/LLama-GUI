"""Routes for llama.cpp install/update management."""

import threading

from ..http import sanitize_error
from ..services import llama_manager
from ..services import process_manager


RELEASE_RESPONSE_LIMIT = 30


def get_releases(request, response, ctx):
    try:
        releases = llama_manager.get_releases(ctx)
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
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported backend: {backend}", 400)
        return
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        ctx.state.install_in_progress = True

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
    if backend not in ctx.services.backend_specs:
        response.error(f"Unsupported configured backend: {backend}", 400)
        return
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            response.error("Installation already in progress", 409)
            return
        ctx.state.install_in_progress = True
    try:
        releases = llama_manager.get_releases(ctx)
        latest = releases[0]["tag_name"] if releases else None
        if latest and latest != tag:

            def _update(latest_tag, backend_name):
                try:
                    llama_manager.install_release(
                        ctx, latest_tag, backend_name, ctx.services.backend_specs
                    )
                finally:
                    with ctx.state.install_lock:
                        ctx.state.install_in_progress = False

            threading.Thread(
                target=_update, args=(latest, backend), daemon=True
            ).start()
            response.json({"status": "started", "from": tag, "to": latest})
        else:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False
            response.json({"status": "already_latest"})
    except Exception as e:
        with ctx.state.install_lock:
            ctx.state.install_in_progress = False
        response.error(sanitize_error(e, 500), 500)
