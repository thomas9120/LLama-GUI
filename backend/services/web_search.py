"""Web search and page text extraction helpers."""

import html
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Optional

from backend import config


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
    except Exception:
        text = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", raw_html)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        text = html.unescape(text)
        return re.sub(r"\s+", " ", text).strip()


def validate_public_hostname(hostname: str, port: int) -> tuple[bool, str]:
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        return False, f"Failed to resolve host: {exc}"
    if not infos:
        return False, f"Failed to resolve host: no addresses for {hostname!r}"
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False, f"Blocked: refusing to fetch non-public address {ip}."
    return True, ""


class ManualRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


NoRedirect = ManualRedirectHandler


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
    handlers = [ManualRedirectHandler]
    if ssl_context is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ssl_context))
    opener = urllib.request.build_opener(*handlers)
    for _ in range(5):
        parsed = urllib.parse.urlparse(current_url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        ok, reason = validate_public_hostname(parsed.hostname, port)
        if not ok:
            return {"ok": False, "error": reason}

        req = urllib.request.Request(
            current_url,
            headers={
                "User-Agent": config.WEB_SEARCH_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
            },
        )
        try:
            resp = opener.open(req, timeout=timeout)
            raw = resp.read(config.WEB_SEARCH_FETCH_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
            text = html_to_readable_text(raw.decode(charset, errors="replace"))
            if len(text) > max_chars:
                text = text[:max_chars].rstrip() + f"\n\n... (truncated, {len(text)} chars total)"
            return {"ok": True, "url": current_url, "text": text or "(page returned no readable text)"}
        except urllib.error.HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308}:
                return {"ok": False, "error": f"Failed to fetch URL: HTTP {exc.code} {getattr(exc, 'reason', '')}"}
            location = exc.headers.get("Location")
            if not location:
                return {"ok": False, "error": "Failed to fetch URL: redirect missing Location header."}
            next_url = urllib.parse.urljoin(current_url, location)
            next_parsed = urllib.parse.urlparse(next_url)
            if next_parsed.scheme not in {"http", "https"} or not next_parsed.hostname:
                return {"ok": False, "error": "Blocked: redirect target is not a valid http/https URL."}
            current_url = next_url
        except Exception as exc:
            return {"ok": False, "error": f"Failed to fetch URL: {exc}"}

    return {"ok": False, "error": "Failed to fetch URL: too many redirects."}


def web_search(query: Any, max_results: int = config.WEB_SEARCH_MAX_RESULTS) -> dict[str, Any]:
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
        return {"ok": False, "error": f"Search failed: {exc}", "results": []}

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
