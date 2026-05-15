"""Routes for web search and page fetching."""

from backend import config
from backend.services import web_search


def search(request, response, ctx):
    body = request.body or {}
    query = body.get("query", "")
    url = body.get("url", "")
    if url:
        response.json(web_search.fetch_page_text(url, ssl_context=ctx.services.ssl_context))
        return
    try:
        max_results = int(body.get("max_results") or config.WEB_SEARCH_MAX_RESULTS)
    except (TypeError, ValueError):
        max_results = config.WEB_SEARCH_MAX_RESULTS
    response.json(web_search.web_search(query, max_results=max(1, min(max_results, 10))))
