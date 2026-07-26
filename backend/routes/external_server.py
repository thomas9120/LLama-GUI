"""Routes for registering an externally started llama-server."""

from ..http import sanitize_error
from ..services import external_server as external_server_service


def _payload(ctx, target=None):
    return {
        "external_chat_target": (
            target if target is not None else external_server_service.get_target(ctx)
        ),
        "remembered_target": external_server_service.get_remembered_target(ctx),
    }


def get_target(request, response, ctx):
    response.json(_payload(ctx))


def connect(request, response, ctx):
    body = request.body or {}
    try:
        if body.get("restore"):
            # Unattended reconnect of the saved address on GUI load. Returns the
            # current (unchanged) state when there is nothing to restore.
            target = external_server_service.reconnect_remembered(ctx)
        else:
            target = external_server_service.connect(
                ctx,
                body.get("host"),
                body.get("port"),
                body.get("api_key", ""),
                body.get("label", ""),
            )
    except ValueError as exc:
        response.error(sanitize_error(exc, 400), 400)
        return
    except external_server_service.ExternalServerUnreachable as exc:
        # Our own message, built from the address the caller just supplied, so
        # there is nothing to sanitize even though this is a 5xx status.
        response.error(str(exc), 502)
        return
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
        return
    response.json(_payload(ctx, target))


def disconnect(request, response, ctx):
    try:
        external_server_service.disconnect(ctx)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
        return
    response.json(_payload(ctx))
