"""Model file API routes."""

# Reserved subfolder: vision projectors live here and are applied via the mmproj
# flag, so they must never appear in the launch model list.
MMPROJ_DIR_NAME = "mmproj"


def _iter_gguf_files(models_dir):
    """Yield .gguf files under ``models_dir``, recursively.

    Symlinks are followed, since linking a large model or a whole folder of them
    into ``models/`` is a normal way to avoid copying gigabytes. Each directory is
    visited at most once by resolved path, so a link cycle cannot hang the route.

    Files are yielded unresolved on purpose: the caller names them by their path
    relative to ``models/``, which is what the user sees in the folder and what
    ``-m models/<name>`` needs. Naming them by their resolved target would put a
    symlinked model outside ``models/`` and drop it from the list entirely.
    """
    seen_dirs = set()
    stack = [(models_dir, True)]
    while stack:
        current, is_root = stack.pop()
        try:
            resolved = current.resolve()
            if resolved in seen_dirs:
                continue
            seen_dirs.add(resolved)
            entries = list(current.iterdir())
        except OSError:
            continue

        for entry in entries:
            try:
                if entry.is_dir():
                    if is_root and entry.name.lower() == MMPROJ_DIR_NAME:
                        continue
                    stack.append((entry, False))
                elif entry.is_file() and entry.suffix.lower() == ".gguf":
                    yield entry
            except OSError:
                # A broken or unreadable link is simply not a model.
                continue


def list_models(request, response, ctx):
    models_dir = ctx.paths.models
    if not models_dir.exists():
        response.json([])
        return

    found = []
    for path in _iter_gguf_files(models_dir):
        try:
            size_mb = path.stat().st_size / (1024 * 1024)
        except OSError:
            continue
        found.append(
            {
                "name": path.relative_to(models_dir).as_posix(),
                "size_mb": round(size_mb, 2),
            }
        )

    response.json(sorted(found, key=lambda item: item["name"].lower()))
