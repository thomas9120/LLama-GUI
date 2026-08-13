"""Routes for native file selection."""

from pathlib import Path

from backend.http import sanitize_error
from backend.services import file_picker, model_dir


def select_file(request, response, ctx):
    body = request.body or {}
    try:
        title, initial_dir, filetypes = file_picker.get_select_file_options(
            ctx,
            body.get("purpose"),
            body.get("title"),
        )
        selected_path = file_picker.select_file_in_native_dialog(
            title=title,
            initial_dir=initial_dir,
            filetypes=filetypes,
        )
        response.json(
            {
                "selected": bool(selected_path),
                "path": selected_path,
            }
        )
    except ValueError as exc:
        response.error(str(exc), 409)
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)


def select_folder(request, response, ctx):
    body = request.body or {}
    title = str(body.get("title") or "Select Models Folder").strip() or "Select Models Folder"
    try:
        info = model_dir.get_models_dir_info(ctx)
        initial_dir = Path(info["models_dir"]) if info["models_dir_available"] else ctx.paths.models.parent
        selected_path = file_picker.select_folder_in_native_dialog(
            title=title,
            initial_dir=initial_dir,
        )
        response.json({"selected": bool(selected_path), "path": selected_path})
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
