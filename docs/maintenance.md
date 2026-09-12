# Maintenance and Tests

Back to the [README](../README.md).

## Remove llama.cpp Files

**Remove llama.cpp Files** clears official runtime files under `llama/bin/`, `llama/dll/`, and `llama/grammars/`, and clears official install metadata in `config.json`. It preserves `models/`, `presets/`, both custom slots (`llama/custom/` and `llama/custom-02/`), and an active custom selection.

### Custom pre-compiled binaries

1. Choose a slot: **Custom** uses `llama/custom/bin/`; **Custom 02** uses `llama/custom-02/bin/`. Put `llama-server`, `llama-cli`, and needed `.dll` / `.so` / `.dylib` files in that slot's `bin/` directory. `llama-bench` and `llama-perplexity` are optional. Installers and app startup create both layouts; **Activate Custom** also creates the selected layout if needed.
2. Stop any running llama.cpp process. In **Install & Update**, choose **Custom** or **Custom 02**, then click **Activate Custom**.
3. Switch back by selecting the preserved official backend and clicking **Activate Existing**; no download is required.

Switching slots preserves both builds and keeps models and presets shared. Removing official llama.cpp files preserves both custom slots and an active custom selection.

## Running Tests

Backend:

```bash
# Windows
.venv\Scripts\python.exe -m unittest discover tests -v
# Linux/macOS
.venv/bin/python -m unittest discover tests -v
```

Run these with the project venv, not system Python: the suite needs runtime dependencies like `huggingface_hub`, and a system interpreter fails with misleading "require the huggingface_hub package" errors.

Frontend smoke tests are for contributors and CI only (`npm ci`, Playwright Chromium, `npm run test:frontend`). Normal installs and Pinokio only need `requirements.txt`.

Test inventory and when to run what: [`docs/tests.md`](tests.md).
