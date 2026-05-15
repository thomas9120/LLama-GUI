"""Routes for server lifecycle: shutdown, restart, open-folder."""

from ..services import lifecycle as lifecycle_service


def post_shutdown(request, response, ctx):
    shutting_down = lifecycle_service.shutdown_gui_server(ctx)
    response.json({"shutting_down": shutting_down})


def post_restart(request, response, ctx):
    restarting = lifecycle_service.restart_gui_server(ctx)
    response.json({"restarting": restarting})


def post_open_folder(request, response, ctx):
    body = request.body or {}
    folder = body.get("folder", "models")
    folder_map = {"models": ctx.paths.models, "llama": ctx.paths.llama}
    target = folder_map.get(folder, ctx.paths.models)
    target.mkdir(parents=True, exist_ok=True)
    try:
        lifecycle_service.open_folder_in_file_manager(target)
        response.json({"opened": True})
    except Exception as e:
        response.error(str(e), 500)
