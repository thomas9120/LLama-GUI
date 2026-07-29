"""Routes for Hugging Face model discovery and downloads."""

import sys

from backend.http import sanitize_error
from backend.services import hf_download


def get_download_status(request, response, ctx):
    response.json(hf_download.get_model_download_snapshot(ctx))


def list_repo_files(request, response, ctx):
    body = request.body or {}
    try:
        repo_id = hf_download.validate_hf_repo_id(body.get("repo_id"))
        revision = hf_download.validate_hf_revision(body.get("revision"))
        token = hf_download.normalize_hf_token(body.get("token"))
        response.json(hf_download.get_hf_gguf_files(repo_id, revision, token))
    except Exception as exc:
        print(f"[hf_download] repo file listing failed: {exc}", file=sys.stderr)
        response.error(sanitize_error(exc, 400), 400)


def start_download(request, response, ctx):
    body = request.body or {}
    try:
        result = hf_download.start_hf_model_download(
            ctx,
            repo_id=body.get("repo_id"),
            revision=body.get("revision"),
            model_file=body.get("model_file"),
            mmproj_file=body.get("mmproj_file"),
            token=hf_download.normalize_hf_token(body.get("token")),
            overwrite=bool(body.get("overwrite")),
            urlopen=ctx.services.urlopen_with_ssl,
        )
        response.json(result)
    except FileExistsError as exc:
        response.error(str(exc), 409, code="exists")
    except Exception as exc:
        print(f"[hf_download] failed to start model download: {exc}", file=sys.stderr)
        response.error(sanitize_error(exc, 400), 400)


def cancel_download(request, response, ctx):
    response.json(hf_download.cancel_hf_model_download(ctx))
