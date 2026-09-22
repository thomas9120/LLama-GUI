"""Routes for llama.cpp install/update management."""

import sys
import threading
import urllib.parse

from ..http import sanitize_error
from ..services import llama_manager
from ..services import process_manager
from ..services import official_backends


RELEASE_RESPONSE_LIMIT = 30
RELEASE_PAGE_SIZE = 100
# Bound lookback so a renamed or discontinued asset cannot exhaust GitHub's
# unauthenticated API quota. Three pages covers roughly 300 nightly builds.
RELEASE_PAGE_LIMIT = 3


def _claim_install_slot(ctx):
    """Atomically keep installs and llama.cpp launches mutually exclusive."""
    return process_manager.claim_install_slot(ctx)


def get_backends(request, response, ctx):
    try:
        query = urllib.parse.parse_qs(request.query or "")
        response.json(official_backends.refresh(ctx, force=query.get("refresh") == ["1"]))
    except Exception as exc:
        print(f"[install] backend discovery failed: {exc}", file=sys.stderr)
        response.error(sanitize_error(exc, 500), 500)


def get_releases(request, response, ctx):
    try:
        repo_api = None
        spec = None
        query = urllib.parse.parse_qs(request.query or "")
        backend = (query.get("backend") or [""])[0].strip()
        if llama_manager.is_custom_backend(backend):
            response.json([])
            return
        if backend:
            spec = official_backends.get_backend_specs(ctx).get(backend)
            if spec is not None:
                repo_api = llama_manager.resolve_repo_api(spec, ctx)
        result = []
        page = 1
        while page <= RELEASE_PAGE_LIMIT:
            releases = llama_manager.get_releases(
                ctx, repo_api, page=page, per_page=RELEASE_PAGE_SIZE
            )
            for r in releases:
                if spec and spec.get("asset"):
                    if llama_manager.missing_release_assets(r, spec):
                        continue
                result.append(
                    {
                        "tag": r["tag_name"],
                        "name": r.get("name", r["tag_name"]),
                        "published": r["published_at"],
                        "assets": [a["name"] for a in r["assets"]],
                    }
                )
                if len(result) == RELEASE_RESPONSE_LIMIT:
                    break
            if result or len(releases) < RELEASE_PAGE_SIZE:
                break
            page += 1
        response.json(result)
    except Exception as e:
        print(f"[install] release lookup failed: {e}", file=sys.stderr)
        response.error(sanitize_error(e, 500), 500)


def get_download_progress(request, response, ctx):
    response.json(llama_manager.get_download_progress_snapshot(ctx))


def start_install(request, response, ctx):
    backend_specs = official_backends.get_backend_specs(ctx)
    body = request.body or {}
    tag = body.get("tag")
    backend = body.get("backend")
    activate_existing = body.get("activate_existing") is True
    if not backend or (not activate_existing and not tag):
        response.error("tag and backend required", 400)
        return
    if llama_manager.is_custom_backend(backend):
        response.error("Use /api/activate-custom to set up the custom backend", 400)
        return
    if backend not in backend_specs:
        response.error(f"Unsupported backend: {backend}", 400)
        return
    claim_error = _claim_install_slot(ctx)
    if claim_error is not None:
        response.error(*claim_error)
        return

    if activate_existing:
        try:
            result = llama_manager.activate_official_backend(ctx, backend)
            if result.get("ok"):
                response.json(result)
            else:
                response.error(
                    result.get("error") or "Could not activate existing backend", 400
                )
        except Exception as exc:
            print(f"[install] activate existing backend failed: {exc}", file=sys.stderr)
            response.error(sanitize_error(exc, 500), 500)
        finally:
            process_manager.release_install_slot(ctx)
        return

    def _install(tag, backend):
        try:
            llama_manager.install_release(ctx, tag, backend, backend_specs)
        finally:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False

    try:
        threading.Thread(target=_install, args=(tag, backend), daemon=True).start()
    except Exception as exc:
        print(f"[install] failed to start install thread: {exc}", file=sys.stderr)
        with ctx.state.install_lock:
            ctx.state.install_in_progress = False
        response.error(sanitize_error(exc, 500), 500)
        return
    response.json({"status": "started"})


def start_update(request, response, ctx):
    backend_specs = official_backends.get_backend_specs(ctx)
    cfg = ctx.services.load_config()
    tag = cfg.get("tag")
    backend = cfg.get("backend")
    if not tag or not backend:
        response.error("Nothing installed to update", 400)
        return
    if llama_manager.is_custom_backend(backend):
        response.error("Cannot auto-update a custom backend installation", 400)
        return
    if backend not in backend_specs:
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
        backend_spec = backend_specs[backend]
        repo_api = llama_manager.resolve_repo_api(backend_spec, ctx)
        latest = None
        for page in range(1, RELEASE_PAGE_LIMIT + 1):
            releases = llama_manager.get_releases(
                ctx, repo_api, page=page, per_page=RELEASE_PAGE_SIZE
            )
            for release in releases:
                # Stop at the installed release even if its assets were removed;
                # an update must not fall back to an older compatible build.
                if release["tag_name"] == tag or not llama_manager.missing_release_assets(
                    release, backend_spec
                ):
                    latest = release["tag_name"]
                    break
            if latest or len(releases) < RELEASE_PAGE_SIZE:
                break
    except Exception as e:
        print(f"[update] release lookup failed: {e}", file=sys.stderr)
        response.error(sanitize_error(e, 500), 500)
        return

    if not latest:
        response.error(
            "No compatible release found for the installed backend. "
            "Select another backend in Install to switch versions.", 400
        )
        return
    if latest == tag:
        response.json({"status": "already_latest"})
        return

    claim_error = _claim_install_slot(ctx)
    if claim_error is not None:
        response.error(*claim_error)
        return

    def _update(latest_tag, backend_name):
        try:
            llama_manager.install_release(
                ctx, latest_tag, backend_name, backend_specs
            )
        finally:
            with ctx.state.install_lock:
                ctx.state.install_in_progress = False

    try:
        threading.Thread(target=_update, args=(latest, backend), daemon=True).start()
    except Exception as exc:
        print(f"[update] failed to start update thread: {exc}", file=sys.stderr)
        with ctx.state.install_lock:
            ctx.state.install_in_progress = False
        response.error(sanitize_error(exc, 500), 500)
        return
    response.json({"status": "started", "from": tag, "to": latest})


def activate_custom(request, response, ctx):
    backend = (request.body or {}).get("backend", "custom")
    if not llama_manager.is_custom_backend(backend):
        response.error("Unsupported custom backend", 400)
        return
    try:
        claim_error = _claim_install_slot(ctx)
        if claim_error is not None:
            response.error(*claim_error)
            return
        try:
            result = llama_manager.activate_custom_backend(ctx, backend)
            response.json(result)
        finally:
            process_manager.release_install_slot(ctx)
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)
