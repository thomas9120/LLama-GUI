# Maintenance and Tests

Back to the [README](../README.md).

## Remove llama.cpp Files

**Remove llama.cpp Files** clears runtime files under `llama/` (`bin`, `grammars`) and resets install metadata in `config.json`. It does **not** remove `models/`, `presets/`, or `llama/custom/`.

### Custom pre-compiled binaries

1. Put binaries (and needed `.dll` / `.so` / `.dylib`) in `llama/custom/bin/` (`llama-server`, `llama-cli`, optionally `llama-bench`, `llama-perplexity`, etc.). Fresh installs create this directory automatically; **Activate Custom** also creates it if needed.
2. In **Install**, choose **Custom (User-Provided)** → **Activate Custom**.
3. Switch back by selecting the preserved official backend and clicking **Activate Existing**; no download is required.

`llama/custom/` is preserved when removing official llama.cpp files.

## Running Tests

Backend:

```bash
python -m unittest discover tests -v
```

Frontend smoke tests are for contributors and CI only (`npm ci`, Playwright Chromium, `npm run test:frontend`). Normal installs and Pinokio only need `requirements.txt`.

Test inventory and when to run what: [`docs/tests.md`](tests.md).
