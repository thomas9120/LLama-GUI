# Llama GUI

Lightweight local GUI launcher for `llama.cpp` on Windows.

It provides a browser UI to:
- install prebuilt `llama.cpp` release binaries by backend (CPU/CUDA/Vulkan/etc.)
- configure and launch `llama-cli` or `llama-server`
- monitor process output in real time
- manage reusable launch presets
- manage sampler presets in the Sampling submenu (with import/export)

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

## Configure UX Highlights

- Search across configuration categories and flags
- `Expand All`, `Collapse All`, and `Clear` controls for accordions
- Short beginner-friendly descriptions with expandable `More info`
- Inline expandable `Beginner tip` badges on key flags
- Recommended defaults enabled out of the box:
  - `-fit` is set to `on`
  - `-c` context default is `16000`

## Presets

### Full App Presets

Saved in `presets/` as JSON files via the Presets tab.

Each preset stores:
- selected tool (`llama-cli` or `llama-server`)
- selected model
- all configured flags

### Sampler Presets (Sampling Submenu)

Available directly in the Sampling section of Configure.

Includes:
- built-in presets: `Balanced`, `Creative`, `Precise`
- custom sampler preset `Save`, `Load`, and `Delete`
- `Import` and `Export` JSON

Storage behavior:
- custom sampler presets are stored in browser `localStorage`
- export creates portable `.json` files
- import accepts single-preset or multi-preset JSON

Note: loading a full app preset can overwrite sampler values, since samplers are part of the full flag set.

## Maintenance

Install tab includes a **Remove llama.cpp Files** action.

It:
- removes runtime files under `llama/` (`bin`, `dll`, `grammars`)
- resets installation metadata in `config.json`

It does not remove:
- model files in `models/`
- saved full presets in `presets/`

## Project Layout

- `server.py` - local HTTP API + process manager + installer
- `ui/` - static frontend (HTML/CSS/JS)
- `llama/bin/` - installed `llama.cpp` executables and runtime files
- `llama/dll/` - optional backend runtime DLLs
- `llama/grammars/` - grammar/schema files shipped with release assets
- `models/` - local model files
- `presets/` - saved launcher presets
- `config.json` - local installation metadata

## Data Locations

- `config.json` - current installed backend/tag metadata
- `presets/` - full app presets (tool/model/flags)
- browser `localStorage` - custom sampler presets

## Notes

- This project is designed for local use (`127.0.0.1`).
- No authentication is enforced by the wrapper itself.
- For remote access, add your own network hardening and auth controls first.
