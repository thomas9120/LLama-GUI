"""Read-only system and GPU telemetry route for the Monitor tab."""

import urllib.parse

from ..http import sanitize_error
from ..services import system_stats


def get_system_stats(request, response, ctx):
    """``GET /api/system-stats`` (``?refresh=1`` bypasses the short-lived cache).

    The route accepts only the fixed ``refresh=1`` form: no commands, provider
    names, or paths. Partial availability still returns HTTP 200; HTTP 500 is
    reserved for failure to construct any safe response.
    """
    query = urllib.parse.parse_qs(request.query, keep_blank_values=True)
    for key, values in query.items():
        if key != "refresh" or any(value != "1" for value in values):
            response.error("Only refresh=1 is accepted", 400)
            return
    force_refresh = "refresh" in query
    try:
        data = system_stats.get_system_stats(ctx, force_refresh=force_refresh)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
        return
    response.json(data)
