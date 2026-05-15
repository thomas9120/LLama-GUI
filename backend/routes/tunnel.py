"""Routes for Cloudflare remote tunnel management."""

from ..services import tunnel as tunnel_service


def get_status(request, response, ctx):
    response.json(tunnel_service.get_remote_tunnel_snapshot(ctx))


def start(request, response, ctx):
    body = request.body or {}
    try:
        ctx.services.set_llama_api_target(body.get("host"), body.get("port"))
    except Exception as e:
        response.error(str(e), 400)
        return
    response.json(tunnel_service.start_remote_tunnel(ctx))


def stop(request, response, ctx):
    response.json(tunnel_service.stop_remote_tunnel(ctx))
