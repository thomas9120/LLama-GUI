# CPPWrap

Lightweight local GUI launcher for `llama.cpp` on Windows.

It provides a browser UI to:
- install prebuilt `llama.cpp` release binaries by backend (CPU/CUDA/Vulkan/etc.)
- configure and launch `llama-cli` or `llama-server`
- monitor process output in real time
- manage reusable launch presets

## Requirements

- Windows 10/11
- Python 3.9+
- Internet access (for fetching GitHub releases and binaries)

## Quick Start

1. Start the app:

```bat
python server.py
```

2. Open `http://127.0.0.1:5240` in your browser.
3. Use the **Install** tab to install a `llama.cpp` release/backend.
4. Place your `.gguf` models in `models/` (or use the folder button in UI).
5. Use the **Configure** tab to select model + flags, then launch.

## Project Layout

- `server.py` - local HTTP API + process manager + installer
- `ui/` - static frontend (HTML/CSS/JS)
- `llama/bin/` - installed `llama.cpp` executables and runtime files
- `llama/dll/` - optional backend runtime DLLs
- `llama/grammars/` - grammar/schema files shipped with release assets
- `models/` - local model files
- `presets/` - saved launcher presets
- `config.json` - local installation metadata

## Notes

- This project is designed for local use (`127.0.0.1`).
- No authentication is enforced by the wrapper itself.
- For remote access, add your own network hardening and auth controls first.
