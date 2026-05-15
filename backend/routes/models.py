"""Model file API routes."""


def list_models(request, response, ctx):
    models = []
    models_dir = ctx.paths.models
    if models_dir.exists():
        for path in sorted(models_dir.iterdir()):
            if path.is_file() and path.suffix.lower() == ".gguf":
                size_mb = path.stat().st_size / (1024 * 1024)
                models.append({"name": path.name, "size_mb": round(size_mb, 2)})
    response.json(models)
