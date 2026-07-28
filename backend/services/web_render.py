"""Headless-browser page rendering using Playwright.

Single-page applications build their content with JavaScript after the initial
HTML loads, so a plain HTTP GET only ever sees an empty shell. This module opens
such pages in a real headless browser, lets the JavaScript run, optionally
dismisses cookie/consent popups, and returns the fully-rendered text.

Playwright is imported lazily so the rest of the backend keeps working when it
is not installed; callers fall back to the plain HTTP fetch in that case.
"""

import re
import threading
import urllib.parse
from typing import Any, Optional

from backend import config
from backend.services import web_search

# Persistent browser profiles cannot be opened concurrently from the same
# directory, so serialise render calls.
_RENDER_LOCK = threading.Lock()


def is_available() -> bool:
    try:
        import playwright  # noqa: F401

        return True
    except Exception:
        return False


def _dismiss_popups(page: Any) -> None:
    for selector in config.WEB_RENDER_DISMISS_SELECTORS:
        try:
            locator = page.locator(selector).first
            if locator.count() > 0 and locator.is_visible():
                locator.click(timeout=1500)
                page.wait_for_timeout(200)
        except Exception:
            continue


def _extract_text(page: Any) -> str:
    """Return clean visible text. inner_text already yields rendered text; only
    fall back to HTML parsing if it fails."""
    try:
        raw = page.inner_text("body")
    except Exception:
        return web_search.html_to_readable_text(page.content())
    raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
    raw = re.sub(r"\n\s+", "\n", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def render_page(
    url: Any,
    max_chars: int = config.WEB_SEARCH_PAGE_CHARS,
    timeout: int = config.WEB_RENDER_TIMEOUT,
    click_selectors: Optional[list[str]] = None,
    headless: bool = True,
) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(str(url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return {"ok": False, "error": "Blocked: only http/https URLs can be rendered."}

    # Enforce the same SSRF public-address guard the plain fetch uses.
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses, reason = web_search.resolve_public_addresses(parsed.hostname, port)
    if addresses is None:
        return {"ok": False, "error": reason}

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        return {"ok": False, "error": f"Rendering unavailable: Playwright not installed ({exc})."}

    launch_kwargs: dict[str, Any] = {"headless": headless}
    if config.WEB_RENDER_CHANNEL:
        launch_kwargs["channel"] = config.WEB_RENDER_CHANNEL

    config.WEB_RENDER_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with _RENDER_LOCK:
        context = None
        try:
            with sync_playwright() as p:
                try:
                    context = p.chromium.launch_persistent_context(
                        str(config.WEB_RENDER_PROFILE_DIR), **launch_kwargs
                    )
                except Exception:
                    # Fall back to bundled Chromium if the requested channel is missing.
                    if "channel" in launch_kwargs:
                        launch_kwargs.pop("channel", None)
                        context = p.chromium.launch_persistent_context(
                            str(config.WEB_RENDER_PROFILE_DIR), **launch_kwargs
                        )
                    else:
                        raise

                page = context.pages[0] if context.pages else context.new_page()
                page.set_default_timeout(timeout * 1000)
                page.goto(str(url), wait_until="domcontentloaded", timeout=timeout * 1000)
                try:
                    page.wait_for_load_state("networkidle", timeout=timeout * 1000)
                except Exception:
                    pass
                page.wait_for_timeout(config.WEB_RENDER_SETTLE_MS)

                _dismiss_popups(page)
                for selector in click_selectors or []:
                    try:
                        page.locator(selector).first.click(timeout=3000)
                        page.wait_for_timeout(config.WEB_RENDER_SETTLE_MS)
                    except Exception:
                        continue

                final_url = page.url
                text = _extract_text(page)
        except Exception as exc:
            return {"ok": False, "error": f"Failed to render URL: {exc}"}
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass

    text = (text or "").strip()
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + f"\n\n... (truncated, {len(text)} chars total)"
    return {"ok": True, "url": final_url, "text": text or "(page rendered no readable text)"}


def fetch_page_smart(
    url: Any,
    ssl_context: Optional[Any] = None,
    max_chars: int = config.WEB_SEARCH_PAGE_CHARS,
) -> dict[str, Any]:
    """Fetch a page's readable text, upgrading to a headless browser when the
    plain fetch looks like an empty JavaScript shell.

    This is a safe drop-in for web_search.fetch_page_text: it falls back to the
    plain fetch whenever rendering is disabled, unavailable, or unsuccessful.
    """
    parsed = urllib.parse.urlparse(str(url or "").strip())
    render_ok = config.WEB_RENDER_ENABLED and is_available() and parsed.scheme in {"http", "https"}
    if not render_ok:
        return web_search.fetch_page_text(url, max_chars=max_chars, ssl_context=ssl_context)

    plain = web_search.fetch_page_text(url, max_chars=max_chars, ssl_context=ssl_context)
    if plain.get("ok") and len(plain.get("text", "")) >= config.WEB_RENDER_MIN_TEXT:
        return plain
    rendered = render_page(url, max_chars=max_chars)
    if rendered.get("ok"):
        return rendered
    return plain if plain.get("ok") else rendered
