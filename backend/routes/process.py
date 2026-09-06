"""Routes for llama.cpp process management."""

import urllib.parse

from ..http import sanitize_error
from ..services import process_manager


def get_output(request, response, ctx):
    params = urllib.parse.parse_qs(request.query, keep_blank_values=True)
    raw_since = params.get("since", [None])[-1]
    if raw_since is None:
        since = None
    else:
        try:
            since = int(raw_since)
        except (TypeError, ValueError):
            response.error("Invalid output cursor", 400)
            return
        if since < 0:
            response.error("Invalid output cursor", 400)
            return
    response.json(process_manager.get_output_snapshot(ctx, since=since))


def launch(request, response, ctx):
    body = request.body or {}
    tool = body.get("tool", "llama-cli")
    args = body.get("args", [])
    launch_context = body.get("launch_context")
    allowed_tools = ctx.services.llama_tools or []
    if tool not in allowed_tools:
        response.error(f"Unknown tool: {tool!r}", 400)
        return
    # flatten_launch_args() iterates whatever it is handed, so a bare string
    # silently became one argument per character rather than being rejected.
    if not isinstance(args, list):
        response.error("args must be an array", 400)
        return
    launch_settings = body.get("launch_settings")
    result = process_manager.launch_process(ctx, tool, args, launch_context, launch_settings)
    if "error" in result:
        response.error(result.get("error", "Launch failed"), 400)
    else:
        response.json(result)


def preflight_launch(request, response, ctx):
    body = request.body or {}
    result = process_manager.preflight_launch(
        ctx,
        body.get("tool", "llama-server"),
        body.get("args"),
        body.get("fingerprint_data"),
    )
    if "error" in result:
        response.error(result.get("error", "Launch preflight failed"), 400)
    else:
        response.json(result)


def fingerprint_preset(request, response, ctx):
    body = request.body or {}
    try:
        fingerprint = process_manager.compute_preset_fingerprint(
            body.get("fingerprint_data")
        )
    except ValueError as exc:
        response.error(str(exc), 400)
        return
    response.json({"ok": True, "preset_fingerprint": fingerprint})


def estimate_memory(request, response, ctx):
    body = request.body or {}
    tool = body.get("tool", "llama-cli")
    args = body.get("args", [])
    result = process_manager.estimate_memory(ctx, tool, args)
    if "error" in result:
        response.error(result.get("error", "Memory estimate failed"), 400, extra=result)
    else:
        response.json(result)


def get_buffer_types(request, response, ctx):
    response.json(process_manager.get_buffer_types(ctx))


def get_health(request, response, ctx):
    query = urllib.parse.parse_qs(request.query, keep_blank_values=True)
    expected_generation = (query.get("expected_generation") or [None])[-1]
    try:
        result = process_manager.get_llama_health(ctx, expected_generation)
    except Exception as exc:
        sanitize_error(exc, 500)
        result = {
            "state": "error",
            "ready": False,
            "generation": None,
            "expected_generation": None,
            "message": "The llama-server health check failed.",
        }
    response.json(result)


def stop(request, response, ctx):
    body = request.body or {}
    if "expected_generation" in body:
        response.json(
            process_manager.stop_process_for_generation(
                ctx, body.get("expected_generation")
            )
        )
        return
    response.json({"stopped": process_manager.stop_process(ctx)})


def send_input(request, response, ctx):
    body = request.body or {}
    response.json({"sent": process_manager.send_input(ctx, body.get("text", ""))})


def cleanup_llama(request, response, ctx):
    # rmtree's the same llama/bin and llama/grammars an install extracts into, so
    # it has to hold the install slot for the duration. The bare
    # is_process_running() check this used to do left a window where an install
    # running concurrently had its freshly extracted files deleted underneath it.
    claim_error = process_manager.claim_install_slot(ctx)
    if claim_error is not None:
        response.error(*claim_error)
        return
    try:
        response.json({"removed_files": process_manager.remove_llama_files(ctx)})
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)
    finally:
        process_manager.release_install_slot(ctx)
