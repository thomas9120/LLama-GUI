"""Routes for llama.cpp process management."""

from ..http import sanitize_error
from ..services import process_manager


def get_output(request, response, ctx):
    response.json(process_manager.get_output_snapshot(ctx))


def launch(request, response, ctx):
    body = request.body or {}
    tool = body.get("tool", "llama-cli")
    args = body.get("args", [])
    allowed_tools = ctx.services.llama_tools or []
    if tool not in allowed_tools:
        response.error(f"Unknown tool: {tool!r}", 400)
        return
    result = process_manager.launch_process(ctx, tool, args)
    if "error" in result:
        response.error(result.get("error", "Launch failed"), 400)
    else:
        response.json(result)


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


def stop(request, response, ctx):
    response.json({"stopped": process_manager.stop_process(ctx)})


def send_input(request, response, ctx):
    body = request.body or {}
    response.json({"sent": process_manager.send_input(ctx, body.get("text", ""))})


def cleanup_llama(request, response, ctx):
    if process_manager.is_process_running(ctx):
        response.error("Stop running process first", 400)
        return
    try:
        response.json({"removed_files": process_manager.remove_llama_files(ctx)})
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)
