"""Small route registry used by the stdlib HTTP entrypoint."""

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple


@dataclass(frozen=True)
class RouteMatch:
    handler: Any
    params: Mapping[str, str]

    @property
    def handler_name(self) -> str:
        if isinstance(self.handler, str):
            return self.handler
        return getattr(self.handler, "__name__", str(self.handler))


@dataclass(frozen=True)
class _Route:
    method: str
    path: str
    handler: Any
    param_name: Optional[str] = None
    is_prefix: bool = False


class Router:
    """Registry for exact and prefix routes.

    Prefix routes are checked in registration order after exact routes. When a
    prefix route has a parameter name, the parameter receives the full raw path
    suffix after the prefix; route handlers can decode or further validate it.
    """

    def __init__(self) -> None:
        self._exact: Dict[Tuple[str, str], RouteMatch] = {}
        self._prefixes: list[_Route] = []

    def add(self, method: str, path: str, handler: Any) -> "Router":
        self._exact[(method.upper(), path)] = RouteMatch(handler, {})
        return self

    def add_prefix(
        self,
        method: str,
        prefix: str,
        handler: Any,
        param_name: Optional[str] = None,
    ) -> "Router":
        self._prefixes.append(
            _Route(
                method=method.upper(),
                path=prefix,
                handler=handler,
                param_name=param_name,
                is_prefix=True,
            )
        )
        return self

    def match(self, method: str, path: str) -> Optional[RouteMatch]:
        method = method.upper()
        exact = self._exact.get((method, path))
        if exact:
            return exact

        for route in self._prefixes:
            if route.method != method or not path.startswith(route.path):
                continue
            params = {}
            if route.param_name:
                params[route.param_name] = path[len(route.path) :]
            return RouteMatch(route.handler, params)
        return None
