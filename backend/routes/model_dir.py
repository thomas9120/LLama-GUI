"""Routes for changing the active model directory."""

from backend.http import sanitize_error
from backend.services import model_dir


def set_models_dir(request, response, ctx):
    body = request.body or {}
    if not isinstance(body, dict) or "path" not in body:
        response.error("Request must include a path value.", 400)
        return
    try:
        response.json(model_dir.set_models_dir(ctx, body.get("path")))
    except model_dir.ModelsDirBusyError as exc:
        response.error(str(exc), 409)
    except ValueError as exc:
        response.error(str(exc), 400)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
