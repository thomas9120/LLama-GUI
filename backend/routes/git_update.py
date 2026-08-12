"""Routes for app update management."""

import urllib.parse

from ..http import sanitize_error
from ..services import git_update


def get_status(request, response, ctx):
    try:
        query = urllib.parse.parse_qs(request.query)
        channel = git_update.normalize_update_channel(
            query.get("channel", ["stable"])[0]
        )
        response.json(
            git_update.get_app_update_status(ctx, fetch=True, channel=channel)
        )
    except ValueError as e:
        response.error(str(e), 400)
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)


def start_update(request, response, ctx):
    try:
        channel = git_update.normalize_update_channel(
            (request.body or {}).get("channel", "stable")
        )
        result = git_update.update_app_from_git(ctx, channel=channel)
        if result.get("error"):
            response.error(
                result.get("error", "App update failed"),
                400,
                extra={key: value for key, value in result.items() if key != "error"},
            )
        else:
            response.json(result)
    except ValueError as e:
        response.error(str(e), 400)
    except Exception as e:
        response.error(sanitize_error(e, 500), 500)
