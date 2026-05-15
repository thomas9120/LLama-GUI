"""Local llama-server metrics proxy route."""

import urllib.parse


def get_metrics(request, response, ctx):
    query = urllib.parse.parse_qs(request.query)
    metrics_text, error = ctx.services.get_local_llama_metrics(
        (query.get("host") or [ctx.config.llama_host])[0],
        (query.get("port") or [str(ctx.config.llama_port)])[0],
    )
    if metrics_text is None:
        response.error(error, 502)
        return
    response.text(metrics_text)
