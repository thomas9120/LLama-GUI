# Potential Improvements

Feature improvement ideas for LLama-GUI, organized by category.

---

## Model Management

- **Model download from UI** — Let users paste a Hugging Face URL and download `.gguf` files directly into `models/`, with progress tracking
- **Model info display** — Show model metadata (parameters, quantization, architecture) when selecting a `.gguf`
- **Model delete/rename** — Add UI actions to manage model files without opening the file manager
- **Model validation** — Check GGUF magic bytes before launch to catch corrupt or wrong files early

## Launch & Monitoring

- **Launch history** — Log past launches (model, flags, timestamp, duration) so users can re-run previous configs
- **Persistent output log** — Save stdout/stderr to a file so output survives page refreshes or restarts
- **Health check dashboard** — When running, show live stats from the `/health` and `/metrics` endpoints (slots used, requests processed, tokens/sec)
- **Multiple process support** — Allow launching a second instance on a different port (e.g., for a draft model or a different model)

## UX & Quality of Life

- **Configurable port** — Let users change the GUI port from the UI or a settings file instead of hardcoding 5240
- **Dark/light theme toggle** — Add a theme switcher; some users prefer light themes
- **Keyboard shortcuts** — Ctrl+L to launch, Ctrl+S to stop, Ctrl+K for search focus, etc.
- **Flag search in Quick Launch** — Add a search/filter to the Quick Launch card grid for users who know what they want
- **Tooltip on command preview** — Hovering over any argument in the preview shows the flag's description and default
- **Favorites/recent models** — Pin frequently used models to the top of the dropdown

## API & Integration

- **Built-in chat interface** — Add a Chat tab that calls the `/v1/chat/completions` endpoint directly, so users don't need an external client
- **API request tester** — In the API tab, add a form to send test requests and see responses inline
- **CORS origin configurator** — Let users whitelist additional origins for development workflows
- **Environment variable editor** — Expose common env vars (e.g., `CUDA_VISIBLE_DEVICES`, `GGML_METAL_PATH`) in a dedicated UI section

## Advanced / Power Users

- **Custom build support** — Allow pointing to a user-compiled `llama-server` binary instead of only using official releases
- **Batch launch configs** — Save and restore entire "environments" (model + flags + port) and switch between them
- **LoRA manager** — UI to list, preview, and manage LoRA adapters in a dedicated folder
- **Grammar editor** — A text editor with syntax highlighting for GBNF grammar files
- **Benchmark tab** — Run `llama-bench` with selected model and display results in a table
- **Quantize tab** — Run `llama-quantize` to convert models between quantization levels with a progress bar

## Observability

- ~~**Token counter** — Show tokens generated, tokens/sec, and total time in the output panel while running~~ ✅ Implemented as a live stats bar at the bottom of the screen
- **Resource monitor** — Display GPU VRAM usage and system RAM usage (if detectable) while the server is running
- **Export logs** — Button to download the full output buffer as a text file

## Distribution & Packaging

- **Docker support** — Generate a `Dockerfile` or `docker-compose.yml` based on the current config
- **Pinokio integration** — A `pinokio.js` launcher so the app can be discovered and launched from Pinokio
- **Auto-start on boot** — Option to register the GUI as a system service/startup item
