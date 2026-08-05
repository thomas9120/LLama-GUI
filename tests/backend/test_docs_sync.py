"""Checks that documentation describing a registry stays in sync with it.

These tests assert nothing about behavior. They exist because the API surface is
described in two documents that no code path reads, so drift is invisible until
someone goes looking: the Route Modules table in ``docs/directory.md`` had five
registered endpoints missing from it, and one row that summarized four routes as
"CRUD + shortcut export".

Both documents are checked in both directions. A route added without a doc row
fails here, and so does a doc row for a route that no longer exists.
"""

import re
import unittest
from pathlib import Path

import backend.app as backend_app


REPO_ROOT = Path(__file__).resolve().parents[2]
DIRECTORY_DOC = REPO_ROOT / "docs" / "directory.md"
ARCHITECTURE_DOC = REPO_ROOT / "docs" / "architecture.html"

# Both documents spell a prefix route with its parameter name, e.g.
# "/api/presets/<name>", because the bare prefix "/api/presets/" would be
# indistinguishable from the exact "/api/presets" route in a table.
ENDPOINT_RE = re.compile(r"\b(GET|POST|DELETE) (/api/[A-Za-z0-9/_<>-]+)")

# architecture.html renders the method as a badge in its own cell, so the method
# and path are separated by markup rather than a space.
HTML_ENDPOINT_RE = re.compile(
    r'<span class="verb \w+">(GET|POST|DELETE)</span>\s*</td>\s*'
    r'<td class="mono">(/api/[^<]*)</td>'
)


def registered_endpoints() -> set[tuple[str, str]]:
    """Every ``(method, path)`` in the live ``API_ROUTER``.

    Reads the router object rather than parsing ``backend/app.py`` as text, so a
    reformatted registry does not break the check. Router internals are private;
    if they are renamed this raises instead of quietly finding zero routes,
    because a docs-sync test that silently passes is worse than none at all.
    """
    router = backend_app.API_ROUTER
    exact = getattr(router, "_exact", None)
    prefixes = getattr(router, "_prefixes", None)
    if exact is None or prefixes is None:
        raise AssertionError(
            "backend.routing.Router no longer exposes _exact/_prefixes. Update "
            "registered_endpoints() in this test so the documentation checks "
            "keep inspecting the real route registry."
        )

    endpoints = {(method, path) for method, path in exact}
    for route in prefixes:
        path = f"{route.path}<{route.param_name}>" if route.param_name else route.path
        endpoints.add((route.method, path))
    return endpoints


def documented_endpoints(text: str) -> set[tuple[str, str]]:
    return set(ENDPOINT_RE.findall(text))


def documented_html_endpoints(html: str) -> set[tuple[str, str]]:
    # Unescape after matching, not before: "&lt;name&gt;" becomes "<name>", and a
    # bare "<" would terminate the path capture early.
    return {
        (method, path.replace("&lt;", "<").replace("&gt;", ">"))
        for method, path in HTML_ENDPOINT_RE.findall(html)
    }


def route_modules_section(markdown: str) -> str:
    """The '### Route Modules' section of docs/directory.md.

    Scoped deliberately: endpoints are mentioned all over that file, and only
    this table claims to be the complete list.
    """
    _, _, after = markdown.partition("### Route Modules")
    if not after:
        raise AssertionError(
            "docs/directory.md no longer has a '### Route Modules' heading. "
            "Update this test to point at wherever the route table moved."
        )
    section, _, _ = after.partition("### Service Modules")
    return section


def api_surface_section(html: str) -> str:
    """The API surface table of docs/architecture.html."""
    _, _, after = html.partition('<h2 id="api">')
    if not after:
        raise AssertionError(
            "docs/architecture.html no longer has an id=\"api\" section. Update "
            "this test to point at wherever the endpoint table moved."
        )
    section, _, _ = after.partition("<h2 ")
    return section


class DocumentedApiSurfaceTests(unittest.TestCase):
    def assert_matches_registry(self, documented, source):
        registered = registered_endpoints()

        undocumented = sorted(registered - documented)
        self.assertEqual(
            undocumented,
            [],
            f"\n{len(undocumented)} route(s) registered in backend/app.py but missing "
            f"from {source}:\n"
            + "\n".join(f"  {method} {path}" for method, path in undocumented),
        )

        stale = sorted(documented - registered)
        self.assertEqual(
            stale,
            [],
            f"\n{len(stale)} route(s) documented in {source} but not registered in "
            f"backend/app.py:\n"
            + "\n".join(f"  {method} {path}" for method, path in stale),
        )

    def test_registry_is_not_empty(self):
        # Guards every other assertion here: two empty sets compare equal, so a
        # parse that finds nothing would make the checks below vacuously pass.
        self.assertGreater(len(registered_endpoints()), 20)

    def test_directory_md_route_table_matches_registry(self):
        section = route_modules_section(DIRECTORY_DOC.read_text(encoding="utf-8"))
        self.assert_matches_registry(
            documented_endpoints(section),
            "the Route Modules table in docs/directory.md",
        )

    def test_architecture_html_api_table_matches_registry(self):
        section = api_surface_section(ARCHITECTURE_DOC.read_text(encoding="utf-8"))
        documented = documented_html_endpoints(section)
        self.assertGreater(
            len(documented),
            20,
            "Parsed almost no endpoints out of docs/architecture.html. The table "
            "markup probably changed; update HTML_ENDPOINT_RE rather than letting "
            "this check pass on an empty set.",
        )
        self.assert_matches_registry(
            documented, "the API surface table in docs/architecture.html"
        )

    def test_directory_md_states_the_endpoint_count(self):
        section = route_modules_section(DIRECTORY_DOC.read_text(encoding="utf-8"))
        match = re.search(r"(\d+) endpoints total", section)
        self.assertIsNotNone(
            match,
            "The Route Modules preamble should state the endpoint count so the "
            "table carries a checkable invariant.",
        )
        self.assertEqual(
            int(match.group(1)),
            len(registered_endpoints()),
            "The endpoint count in docs/directory.md disagrees with API_ROUTER.",
        )


if __name__ == "__main__":
    unittest.main()
