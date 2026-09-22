"""Discover official CUDA/ROCm packages without changing installed selections."""

import copy
import json
import os
import re
import sys
import time


CACHE_TTL = 3600
RETRY_INTERVAL = 30
PAGE_SIZE = 100
PAGE_LIMIT = 3
TAG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
PACKAGE_RE = re.compile(
    r"(win|ubuntu)-(cuda|rocm)-(\d+(?:\.\d+){1,2})-(x64|arm64)\.(zip|tar\.gz)"
)


def release_specs(release, platform, arch):
    """Parse recognized packages; incomplete CUDA pairs remain ineligible."""
    platform_token = "win" if platform == "win32" else "ubuntu" if platform.startswith("linux") else None
    tag = release.get("tag_name", "")
    if not platform_token or not isinstance(tag, str) or not TAG_RE.fullmatch(tag):
        return {}
    assets = release.get("assets", [])
    if not isinstance(assets, list):
        return {}
    names = {a["name"] for a in assets if isinstance(a, dict) and isinstance(a.get("name"), str)}
    prefix = f"llama-{tag}-bin-"
    result = {}
    for name in sorted(names):
        if not name.startswith(prefix):
            continue
        match = PACKAGE_RE.fullmatch(name[len(prefix):])
        if not match:
            continue
        system, family, version, machine, extension = match.groups()
        if (system, machine) != (platform_token, arch):
            continue
        if extension != ("zip" if system == "win" else "tar.gz"):
            continue
        spec = {
            "label": f"CUDA {version} (NVIDIA)" if family == "cuda" else
                     f"ROCm {version} (AMD, Official; separate runtime required)",
            # Preserve a literal {tag} placeholder, matching built-in specs.
            "asset": "llama-{tag}-bin-" + name[len(prefix):],
            "official_package": {"platform": platform, "arch": arch, "id": f"{family}-{version}"},
        }
        if family == "cuda":
            # Windows currently publishes untagged runtimes; Linux tags them.
            # Resolve from each release so either convention can be used safely.
            tagged = f"cudart-llama-{tag}-bin-{system}-cuda-{version}-{arch}.{extension}"
            untagged = f"cudart-llama-bin-{system}-cuda-{version}-{arch}.{extension}"
            candidates = [untagged, tagged] if system == "win" else [tagged, untagged]
            runtime = next((item for item in candidates if item in names), candidates[0])
            if runtime == tagged:
                runtime = f"cudart-llama-{{tag}}-bin-{system}-cuda-{version}-{arch}.{extension}"
            spec["extra_assets"] = [runtime]
        result[f"{family}-{version}"] = spec
    return result


def resolve_release_spec(release, spec):
    package = spec.get("official_package")
    if not package:
        return spec
    return release_specs(release, package["platform"], package["arch"]).get(package["id"], spec)


def _collect(releases, platform, arch):
    records, specs = {}, {}
    for release in releases:
        if not isinstance(release, dict) or release.get("draft"):
            continue
        assets = release.get("assets", [])
        if not isinstance(assets, list):
            continue
        names = {a["name"] for a in assets if isinstance(a, dict) and isinstance(a.get("name"), str)}
        for key, spec in release_specs(release, platform, arch).items():
            required = [spec["asset"], *spec.get("extra_assets", [])]
            required = [name.format(tag=release["tag_name"]) for name in required]
            if key in specs or not all(name in names for name in required):
                continue
            specs[key] = spec
            records[key] = {"tag_name": release["tag_name"], "assets": [{"name": name} for name in required]}
    return records, specs


def _cache_path(ctx):
    return ctx.paths.llama / "official-backends.json"


def _load(ctx):
    # Called under the catalog lock. Disk-only and performed once per process.
    state = ctx.state.official_backend_catalog
    if state.get("loaded"):
        return
    state.update(loaded=True, records={}, specs={}, last_attempt=0, warning="")
    try:
        with _cache_path(ctx).open(encoding="utf-8") as handle:
            cached = json.loads(handle.read(2_000_001))
        if (cached.get("platform"), cached.get("arch")) != (ctx.services.current_platform, ctx.services.current_arch):
            return
        records, specs = _collect(cached["releases"], ctx.services.current_platform, ctx.services.current_arch)
        state.update(records=records, specs=specs)
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"[official_backends] could not read cached catalog: {exc}", file=sys.stderr)


def get_backend_specs(ctx):
    """Return a local snapshot. Status polling never contacts GitHub."""
    with ctx.state.official_backend_lock:
        _load(ctx)
        discovered = copy.deepcopy(ctx.state.official_backend_catalog["specs"])
    specs = copy.deepcopy(dict(ctx.services.backend_specs))
    for key, spec in discovered.items():
        # Keep historical IDs used by saved configs instead of adding duplicates.
        if key == "rocm-7.14":
            alias = "hip" if ctx.services.current_platform == "win32" else "rocm"
            if alias in specs:
                key = alias
        specs[key] = spec
    return specs


def refresh(ctx, force=False):
    """Coalesce refreshes and retain last-known packages on failure or removal."""
    from . import llama_manager

    with ctx.state.official_backend_refresh_lock:
        now = time.monotonic()
        with ctx.state.official_backend_lock:
            _load(ctx)
            state = ctx.state.official_backend_catalog
            interval = RETRY_INTERVAL if force or state.get("warning") else CACHE_TTL
            if state["last_attempt"] and now - state["last_attempt"] < interval:
                return {"warning": state["warning"]}
            state["last_attempt"] = now
        try:
            releases = []
            for page in range(1, PAGE_LIMIT + 1):
                batch = llama_manager.get_releases(ctx, ctx.config.github_api, page=page, per_page=PAGE_SIZE)
                releases.extend(batch)
                if len(batch) < PAGE_SIZE:
                    break
            # Recover the installed version even if it is outside the scan window.
            cfg = ctx.services.load_config()
            installed = [cfg, cfg.get("official_install") or {}]
            known_tags = {item.get("tag_name") for item in releases}
            for item in installed:
                if not isinstance(item, dict):
                    continue
                tag, backend = item.get("tag"), item.get("backend", "")
                if not isinstance(tag, str) or not TAG_RE.fullmatch(tag) or tag in known_tags:
                    continue
                if not isinstance(backend, str) or not (backend.startswith(("cuda-", "rocm-")) or backend in ("hip", "rocm")):
                    continue
                known_tags.add(tag)
                try:
                    releases.append(llama_manager.get_release_by_tag(ctx, tag, ctx.config.github_api))
                except Exception as exc:
                    print(f"[official_backends] installed release lookup failed: {exc}", file=sys.stderr)
            records, specs = _collect(releases, ctx.services.current_platform, ctx.services.current_arch)
            with ctx.state.official_backend_lock:
                state["records"].update(records)
                state["specs"].update(specs)
                state["warning"] = ""
                cached = {"platform": ctx.services.current_platform, "arch": ctx.services.current_arch,
                          "releases": list(state["records"].values())}
            path = _cache_path(ctx)
            temporary = path.with_suffix(".tmp")
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary.write_text(json.dumps(cached), encoding="utf-8")
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        except Exception as exc:
            print(f"[official_backends] catalog refresh failed: {exc}", file=sys.stderr)
            with ctx.state.official_backend_lock:
                state["warning"] = "Could not refresh official CUDA/ROCm versions. Keeping saved backend options."
        with ctx.state.official_backend_lock:
            return {"warning": state["warning"]}
