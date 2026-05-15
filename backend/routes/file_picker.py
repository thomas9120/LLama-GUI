"""Routes for native file selection."""

from backend.services import file_picker


def select_file(request, response, ctx):
    body = request.body or {}
    title, initial_dir, filetypes = file_picker.get_select_file_options(
        ctx,
        body.get("purpose"),
        body.get("title"),
    )
    initial_dir.mkdir(parents=True, exist_ok=True)

    try:
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
    except Exception as exc:
        response.error(str(exc), 500)
