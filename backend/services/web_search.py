"""Web search and page text extraction helpers."""

import html
import http.client
import ipaddress
import json
import re
import socket
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Optional

from backend import config
from backend.http import sanitize_error


class ReadableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0
        self.block_tags = {
            "article",
            "blockquote",
            "br",
            "dd",
            "div",
            "dl",
            "dt",
            "figcaption",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "header",
            "li",
            "main",
            "nav",
            "ol",
            "p",
            "pre",
            "section",
            "table",
            "td",
            "th",
            "tr",
            "ul",
        }

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"}:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        text = data.strip()
        if text:
            self.parts.append(text)

    def text(self) -> str:
        raw = html.unescape(" ".join(self.parts))
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r"\n\s+", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def html_to_readable_text(raw_html: str) -> str:
    parser = ReadableHTMLParser()
    try:
        parser.feed(raw_html)
        parser.close()
        return parser.text()
    except Exception as exc:
        print(f"[web_search] HTML parser failed, using regex fallback: {exc}", file=sys.stderr)
        text = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", raw_html)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        text = html.unescape(text)
        return re.sub(r"\s+", " ", text).strip()


def resolve_public_addresses(hostname: str, port: int) -> tuple[Optional[list[Any]], str]:
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        return None, f"Failed to resolve host: {exc}"
    if not infos:
        return None, f"Failed to resolve host: no addresses for {hostname!r}"
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        # `is_global` is the authoritative check and subsumes the rest; the explicit
        # flags stay because they document intent and because is_global's definition
        # has shifted between Python versions. Listing only the flags let CGNAT space
        # (100.64.0.0/10, which Tailscale hands out) through: it is absent from
        # ipaddress's private-network table and is excluded only by is_global.
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return None, f"Blocked: refusing to fetch non-public address {ip}."
    return infos, ""


def validate_public_hostname(hostname: str, port: int) -> tuple[bool, str]:
    addresses, reason = resolve_public_addresses(hostname, port)
    return addresses is not None, reason


class ManualRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


NoRedirect = ManualRedirectHandler


def _connect_validated(addresses: list[Any], timeout: float, source_address: Any = None) -> Any:
    last_error = None
    for family, socktype, proto, _, sockaddr in addresses:
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
    if last_error is not None:
        raise last_error
    raise OSError("No validated addresses available")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, addresses: list[Any], timeout: float) -> None:
        self._validated_addresses = addresses
        super().__init__(host, port=port, timeout=timeout)

    def connect(self) -> None:
        self.sock = _connect_validated(
            self._validated_addresses,
            self.timeout,
            self.source_address,
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        host: str,
        port: int,
        addresses: list[Any],
        timeout: float,
        ssl_context: Optional[Any],
    ) -> None:
        self._validated_addresses = addresses
        super().__init__(host, port=port, timeout=timeout, context=ssl_context)

    def connect(self) -> None:
        sock = _connect_validated(
            self._validated_addresses,
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _open_validated_url(
    parsed: urllib.parse.ParseResult,
    addresses: list[Any],
    timeout: float,
    ssl_context: Optional[Any],
) -> tuple[int, str, Any, bytes]:
    # Connects directly to the pre-validated addresses (no system proxy
    # support): routing through a proxy would bypass the SSRF IP pinning.
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    connection_class = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
    if parsed.scheme == "https":
        connection = connection_class(parsed.hostname, port, addresses, timeout, ssl_context)
    else:
        connection = connection_class(parsed.hostname, port, addresses, timeout)
    target = urllib.parse.urlunparse(("", "", parsed.path or "/", parsed.params, parsed.query, ""))
    try:
        connection.request(
            "GET",
            target,
            headers={
                "User-Agent": config.WEB_SEARCH_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
            },
        )
        response = connection.getresponse()
        raw = response.read(config.WEB_SEARCH_FETCH_BYTES)
        return response.status, response.reason, response.headers, raw
    finally:
        connection.close()


def fetch_page_text(
    url: Any,
    max_chars: int = config.WEB_SEARCH_PAGE_CHARS,
    timeout: int = config.WEB_SEARCH_TIMEOUT,
    ssl_context: Optional[Any] = None,
) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(str(url or "").strip())
    if parsed.scheme not in {"http", "https"}:
        return {"ok": False, "error": f"Blocked: only http/https URLs are allowed (got {parsed.scheme!r})."}
    if not parsed.hostname:
        return {"ok": False, "error": "Blocked: URL is missing a hostname."}

    current_url = urllib.parse.urlunparse(parsed)
    for _ in range(5):
        parsed = urllib.parse.urlparse(current_url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses, reason = resolve_public_addresses(parsed.hostname, port)
        if addresses is None:
            return {"ok": False, "error": reason}

        try:
            status, status_reason, headers, raw = _open_validated_url(
                parsed,
                addresses,
                timeout,
                ssl_context,
            )
            if status in {301, 302, 303, 307, 308}:
                location = headers.get("Location")
                if not location:
                    return {"ok": False, "error": "Failed to fetch URL: redirect missing Location header."}
                next_url = urllib.parse.urljoin(current_url, location)
                next_parsed = urllib.parse.urlparse(next_url)
                if next_parsed.scheme not in {"http", "https"} or not next_parsed.hostname:
                    return {"ok": False, "error": "Blocked: redirect target is not a valid http/https URL."}
                current_url = next_url
                continue
            if status >= 300:
                return {"ok": False, "error": f"Failed to fetch URL: HTTP {status} {status_reason}"}
            charset = headers.get_content_charset() or "utf-8"
            text = html_to_readable_text(raw.decode(charset, errors="replace"))
            if len(text) > max_chars:
                text = text[:max_chars].rstrip() + f"\n\n... (truncated, {len(text)} chars total)"
            return {"ok": True, "url": current_url, "text": text or "(page returned no readable text)"}
        except Exception as exc:
            return {"ok": False, "error": f"Failed to fetch URL: {exc}"}

    return {"ok": False, "error": "Failed to fetch URL: too many redirects."}


def ddgs_search(query: Any, max_results: int = config.WEB_SEARCH_MAX_RESULTS) -> dict[str, Any]:
    query = str(query or "").strip()
    if not query:
        return {"ok": False, "error": "No query provided.", "results": []}
    try:
        from ddgs import DDGS
    except ImportError:
        return {
            "ok": False,
            "error": "Search unavailable: install dependencies again so the ddgs package is available.",
            "results": [],
        }

    try:
        rows = DDGS(timeout=config.WEB_SEARCH_TIMEOUT).text(query, max_results=max_results)
    except Exception as exc:
        return {
            "ok": False,
            "error": f"Search failed: {sanitize_error(exc, 500)}",
            "results": [],
        }

    results = []
    for row in rows or []:
        url = row.get("href") or row.get("url") or ""
        if not url:
            continue
        results.append(
            {
                "title": row.get("title") or url,
                "url": url,
                "snippet": row.get("body") or row.get("snippet") or "",
            }
        )
    return {"ok": True, "query": query, "results": results}


def _searxng_valid_result_url(url: Any) -> bool:
    """A SearXNG result URL must be a non-empty http(s) string with a hostname.

    Rejecting anything else here keeps a malformed row (e.g. a non-string URL,
    or one with an invalid port such as ``http://host:bad``) from reaching the
    Chat caller, which would later pass it to urlparse()/fetch_page_text() and
    raise there instead of falling back.
    """
    if not isinstance(url, str) or not url:
        return False
    try:
        parsed = urllib.parse.urlparse(url)
        # Accessing .port forces port validation: a non-numeric or out-of-range
        # port raises ValueError here rather than later in fetch_page_text().
        parsed.port
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _searxng_text(value: Any) -> str:
    """Normalize an optional text field: keep strings, drop anything else."""
    return value if isinstance(value, str) else ""


def searxng_search(query: Any, max_results: int = config.WEB_SEARCH_MAX_RESULTS) -> dict[str, Any]:
    """Query a SearXNG JSON endpoint, returning normalized results.

    Connects directly (ignoring any environment proxy) because SearXNG is
    expected to be a local/trusted host. Any problem -- an invalid endpoint URL,
    an unreachable instance, a non-JSON or non-object response, a missing results
    list, a malformed result row, etc. -- is logged to stderr and reported as a
    generic failure so that web_search() falls back to ddgs. The SearXNG instance
    must expose the JSON format (its settings.yml must include ``json`` under
    ``search.formats``).
    """
    query = str(query or "").strip()
    if not query:
        return {"ok": False, "error": "No query provided.", "results": []}
    base = str(config.WEB_SEARCH_SEARXNG_URL or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "error": "SearXNG endpoint not configured.", "results": []}

    # Everything below can fail on a misconfigured or hostile instance, so it is
    # all guarded -- including endpoint parsing, which raises on inputs such as
    # "http://[bad" -- and a failure falls back to ddgs via web_search().
    try:
        parsed = urllib.parse.urlparse(base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"invalid endpoint URL: {base!r}")
        parsed.port  # force port validation (raises ValueError on a bad port)
        # No safesearch override: the instance's configured policy applies.
        params = urllib.parse.urlencode({"q": query, "format": "json"})
        endpoint = f"{base}/search?{params}"
        request = urllib.request.Request(
            endpoint,
            headers={"User-Agent": config.WEB_SEARCH_USER_AGENT, "Accept": "application/json"},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=config.WEB_SEARCH_TIMEOUT) as response:
            raw = response.read(config.WEB_SEARCH_FETCH_BYTES)
        data = json.loads(raw.decode("utf-8", errors="replace"))
        if not isinstance(data, dict):
            raise ValueError("response was not a JSON object")
        rows = data.get("results")
        if not isinstance(rows, list):
            raise ValueError("response had no results list")
        results = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            url = row.get("url")
            if not _searxng_valid_result_url(url):
                continue
            results.append(
                {
                    "title": _searxng_text(row.get("title")) or url,
                    "url": url,
                    "snippet": _searxng_text(row.get("content")) or _searxng_text(row.get("snippet")),
                }
            )
            if len(results) >= max_results:
                break
    except Exception as exc:
        print(f"[web_search] SearXNG search failed: {exc}", file=sys.stderr)
        return {"ok": False, "error": "SearXNG search failed.", "results": []}
    return {"ok": True, "query": query, "results": results}


def web_search(query: Any, max_results: int = config.WEB_SEARCH_MAX_RESULTS) -> dict[str, Any]:
    """Run a web search, preferring SearXNG when configured and falling back to
    DuckDuckGo (ddgs)."""
    query = str(query or "").strip()
    if not query:
        return {"ok": False, "error": "No query provided.", "results": []}
    if str(config.WEB_SEARCH_SEARXNG_URL or "").strip():
        searxng_result = searxng_search(query, max_results=max_results)
        if searxng_result.get("ok") and searxng_result.get("results"):
            return searxng_result
    return ddgs_search(query, max_results=max_results)
