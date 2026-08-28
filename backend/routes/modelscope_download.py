"""Routes for ModelScope (魔搭) model discovery and downloads.

Status and cancellation are intentionally shared with the HF routes: both
services drive the same ``ctx.state.model_download`` state machine, so the
frontend polls ``/api/hf/download-status`` and cancels via
``/api/hf/download-cancel`` regardless of the selected source.
"""

import sys

from backend.http import sanitize_error
from backend.services import modelscope_download as ms_download


def list_repo_files(request, response, ctx):
    body = request.body or {}
    try:
        repo_id = ms_download.validate_hf_repo_id(body.get("repo_id"))
        files = ms_download.get_ms_model_files(repo_id, ctx.services.urlopen_with_ssl)
        response.json(ms_download.annotate_exists(ctx, files))
    except Exception as exc:
        print(f"[ms_download] repo file listing failed: {exc}", file=sys.stderr)
        response.error(sanitize_error(exc, 400), 400)


def start_download(request, response, ctx):
    body = request.body or {}
    try:
        result = ms_download.start_ms_model_download(
            ctx,
            repo_id=body.get("repo_id"),
            model_file=body.get("model_file"),
            mmproj_file=body.get("mmproj_file"),
            overwrite=bool(body.get("overwrite")),
            urlopen=ctx.services.urlopen_with_ssl,
        )
        response.json(result)
    except FileExistsError as exc:
        response.error(str(exc), 409, code="exists")
    except Exception as exc:
        print(f"[ms_download] failed to start model download: {exc}", file=sys.stderr)
        response.error(sanitize_error(exc, 400), 400)
