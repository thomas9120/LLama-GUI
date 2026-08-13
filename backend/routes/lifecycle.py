"""Routes for server lifecycle: shutdown, restart, open-folder."""

import sys

from ..http import sanitize_error
from ..services import lifecycle as lifecycle_service
from ..services import model_dir


def post_shutdown(request, response, ctx):
    shutting_down = lifecycle_service.shutdown_gui_server(ctx)
    response.json({"shutting_down": shutting_down})


def post_restart(request, response, ctx):
    restarting = lifecycle_service.restart_gui_server(ctx)
    response.json({"restarting": restarting})


def post_open_folder(request, response, ctx):
    body = request.body or {}
    folder = body.get("folder", "models")
    if not isinstance(folder, str):
        response.error("Invalid folder name.", 400)
        return
    try:
        if folder == "llama":
            target = ctx.paths.llama
            target.mkdir(parents=True, exist_ok=True)
        else:
            target = model_dir.get_models_dir(ctx)
        lifecycle_service.open_folder_in_file_manager(target)
        response.json({"opened": True})
    except ValueError as exc:
        response.error(str(exc), 409)
    except Exception as e:
        print(f"Failed to open folder: {e}", file=sys.stderr)
        response.error(sanitize_error(e, 500), 500)
