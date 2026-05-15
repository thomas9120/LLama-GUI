"""Routes for app update management."""

from ..services import git_update


def get_status(request, response, ctx):
    try:
        response.json(git_update.get_app_update_status(ctx, fetch=True))
    except Exception as e:
        response.error(str(e), 500)


def start_update(request, response, ctx):
    try:
        result = git_update.update_app_from_git(ctx)
        if result.get("error"):
            response.error(
                result.get("error", "App update failed"),
                400,
                extra={key: value for key, value in result.items() if key != "error"},
            )
        else:
            response.json(result)
    except Exception as e:
        response.error(str(e), 500)
