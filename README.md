# Llama GUI

<p align="left">
  <img src="Llama-GUI%20Logo.png" alt="Llama GUI logo" width="360">
</p>

Lightweight local launcher and control panel for `llama.cpp` on Windows, macOS, and Linux.

Llama GUI provides a browser UI to:
- install prebuilt `llama.cpp` releases by backend (CPU/CUDA/Vulkan/SYCL/HIP)
- use a beginner-friendly **Quick Launch** tab for fast startup
- configure and launch `llama-server` or `llama-cli`
- benchmark local models with `llama-bench` throughput tests and `llama-perplexity`
- chat with the model directly from a built-in chat interface
- optionally search the web from Chat with zero API-key setup, using free DuckDuckGo-backed search
- monitor process output in real time
- view live server stats (prompt tokens, generation speed, KV cache usage)
- use OpenAI-compatible endpoint helpers/snippets
- manage full launch presets and sampler presets
- export Windows preset shortcuts that open Llama GUI with a saved preset already loaded
- manage local app updates from GitHub

## Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Install With Pinokio](#install-with-pinokio)
- [Screenshots](#screenshots)
- [Getting Models](#getting-models)
- [Install By Platform](#install-by-platform)
- [First-Run Checklist (60 Seconds)](#first-run-checklist-60-seconds)
- [What Each Tab Does](#what-each-tab-does)
- [Chat Web Search](#chat-web-search)
- [Sampler Presets](#sampler-presets)
- [Server Stats Bar](#server-stats-bar)
- [MCP and Built-in Tools Notes](#mcp-and-built-in-tools-notes)
- [Maintenance Behavior](#maintenance-behavior)
- [Project Layout](#project-layout)
- [Data Locations](#data-locations)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)
- [Cross-Platform Notes](#cross-platform-notes)
- [Running Tests](#running-tests)

## Requirements

- Python 3.9+
- `pip` and virtual environment support (`python -m venv`)
- Internet access (for release metadata/downloads, optional app updates, and optional Chat web search)
- A supported OS/architecture for the prebuilt `llama.cpp` binaries you want to install

Supported prebuilt backends vary by platform:
- Windows: CPU, CUDA, Vulkan, SYCL, HIP
- macOS: Apple Silicon (`Metal`, optional `KleidiAI`) and Intel CPU builds
- Linux: CPU, Vulkan, ROCm, OpenVINO (depends on architecture)

## Quick Start

### One-command install

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/thomas9120/LLama-GUI/main/online_installers/install-online.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/thomas9120/LLama-GUI/main/online_installers/install-online.ps1 | iex
```

The online installer clones Llama GUI into `~/LLama-GUI` on macOS/Linux or `%USERPROFILE%\LLama-GUI` on Windows, installs the Python dependencies, and starts the app. To install somewhere else, set `LLAMA_GUI_INSTALL_DIR` before running the command. To install without starting the app, set `LLAMA_GUI_NO_START=1`.

On Windows, the installer also creates a **Llama GUI** desktop shortcut. The shortcut starts the local Python server and opens the browser after the app is reachable.

### Manual install

1. Clone this repository:

```bash
git clone https://github.com/thomas9120/LLama-GUI.git
cd LLama-GUI
```

2. Install Python dependencies into the local virtual environment:

```bash
./install.sh
```

Windows:
- `windows_install.bat`

If macOS or Linux reports `zsh: permission denied` when running a helper
script, restore the executable bit and rerun the command:

```bash
chmod +x install.sh mac_linux_start.sh mac_linux_silent_start.sh
```

3. Start the app:

```bash
./mac_linux_start.sh
```

Platform launch helpers:
- Windows: `windows_start.bat` or `windows_startsilent.bat`
- macOS/Linux: `./mac_linux_start.sh` or `./mac_linux_silent_start.sh`

4. Open `http://127.0.0.1:5240` in your browser.
5. In **Install**, choose a version + backend, then click **Install**.
6. Put `.gguf` files in `models/` (or click **Open Models**), or use the Hugging Face downloader in **Quick Launch**.
7. In **Quick Launch**, select a model, keep the beginner defaults or choose a profile, and click **Launch**.
8. Open **Chat** to talk to the running server. Enable **Web Search** when you want the model to search the web before answering.
9. Use **Configure** when you want full flag-by-flag control.

## Install With Pinokio

If you use [Pinokio](https://pinokio.computer/), you can install and launch Llama GUI through the separate one-click launcher repo:

[thomas9120/llama-gui-pinokio](https://github.com/thomas9120/llama-gui-pinokio)

The Pinokio launcher clones this app, installs the Python dependencies, and starts the local web UI. Llama GUI's own **Install** tab still manages `llama.cpp` backend downloads, models, presets, and server launches.

## Screenshots

| Quick Launch | Configure |
| --- | --- |
| ![Quick Launch tab](docs/images/quick-launch.png) | ![Configure tab](docs/images/configure.png) |

| Chat | API |
| --- | --- |
| ![Chat tab](docs/images/chat.png) | ![API tab](docs/images/api.png) |

| Install | Presets |
| --- | --- |
| ![Install tab](docs/images/install.png) | ![Presets tab](docs/images/presets.png) |

## Getting Models

Manual model management is always supported: download `llama.cpp`-compatible `.gguf` models from [Hugging Face](https://huggingface.co/) or another trusted source, then place the files in the local `models/` folder. After that, they will appear in **Quick Launch** and **Configure**.

You can also download models from inside the app:

1. Open **Quick Launch**.
2. In **Model**, enter a Hugging Face repo ID such as `owner/model-GGUF`.
3. Click **Find GGUF Files**, choose a model file, then click **Download**.

For vision/multimodal models, download the matching `mmproj` companion file when the repo provides one. Llama GUI stores downloaded projector files under `models/mmproj/` and applies the `Multimodal Projector` launch setting automatically.

## Install By Platform

### Windows

1. Install Python 3.9+ from [python.org](https://www.python.org/downloads/) and make sure it is available in `PATH`.
2. Clone this repository:

```bat
git clone https://github.com/thomas9120/LLama-GUI.git
cd LLama-GUI
```

3. Run `windows_install.bat`.
4. Start the app from the **Llama GUI** desktop shortcut, or use one of:
   - `windows_start.bat`
   - `windows_startsilent.bat`
5. Open `http://127.0.0.1:5240` in your browser.
6. In the **Install** tab, choose a Windows backend such as `CPU`, `CUDA`, `Vulkan`, `SYCL`, or `HIP`, then click **Install**.
7. Go to **Quick Launch** for the simplest first run, or **Configure** for full manual tuning.

To recreate the desktop shortcut without reinstalling dependencies:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create_windows_shortcuts.ps1 -ShortcutsOnly
```

### macOS

1. Install Python 3.9+.
   - If needed with Homebrew: `brew install python`
2. Clone this repository:

```bash
git clone https://github.com/thomas9120/LLama-GUI.git
cd LLama-GUI
```

3. Make the helper scripts executable if needed:

```bash
chmod +x install.sh mac_linux_start.sh mac_linux_silent_start.sh
```

4. Run `./install.sh`.
5. Start the app with one of:
- `./mac_linux_start.sh`
- `./mac_linux_silent_start.sh`
6. Open `http://127.0.0.1:5240` in your browser.
7. In the **Install** tab, choose the backend that matches your Mac:
   - Apple Silicon: `Metal` or `Metal + KleidiAI`
   - Intel Mac: `CPU`
8. Go to **Quick Launch** for the simplest first run, or **Configure** for full manual tuning.

### Linux

1. Install Python 3.9+ and basic system tools:

```bash
sudo apt update
sudo apt install -y python3 git
```

2. Clone this repository:

```bash
git clone https://github.com/thomas9120/LLama-GUI.git
cd LLama-GUI
```

3. Make the helper scripts executable:

```bash
chmod +x install.sh mac_linux_start.sh mac_linux_silent_start.sh
```

4. Run `./install.sh`.
5. Start the app with one of:
- `./mac_linux_start.sh`
- `./mac_linux_silent_start.sh`
6. Open `http://127.0.0.1:5240` in your browser.
7. In the **Install** tab, choose a Linux backend supported by your machine, such as `CPU`, `Vulkan`, `ROCm`, or `OpenVINO`.
8. Go to **Quick Launch** for the simplest first run, or **Configure** for full manual tuning.

Note: some Linux accelerator backends may also require vendor drivers or runtime packages outside of Llama GUI itself.

For users who want to compile `llama.cpp` with CUDA on Linux, the standalone `Linux_compile_toolkit/` folder includes a helper script that fetches upstream `llama.cpp`, builds a CUDA-enabled release, and packages the binaries into a `.tar.gz`.

### Headless or LAN Access

By default, Llama GUI only listens on `127.0.0.1:5240`. On a trusted LAN or VPN, you can opt in to remote browser access with environment variables:

```bash
LLAMA_GUI_HOST=0.0.0.0 LLAMA_GUI_PORT=5240 python server.py
```

Then open `http://<server-ip>:5240` from another machine. `LLAMA_GUI_PORT` is optional and defaults to `5240`.

The bundled start scripts also honor these variables. If `LLAMA_GUI_HOST` is a wildcard bind address such as `0.0.0.0`, `::`, or `*`, the script still starts the server with that bind address but opens the local browser at `127.0.0.1:<port>`.

Access by IP address works by default. If you want to open the UI through a LAN hostname, mDNS name, or reverse-proxy hostname, explicitly trust that browser hostname too:

```bash
LLAMA_GUI_HOST=0.0.0.0 LLAMA_GUI_ALLOWED_HOSTS=llama-box.local python server.py
```

Do not expose this admin UI directly to the public internet. Llama GUI does not enforce its own authentication layer; use a trusted network, VPN, or authenticated reverse proxy.

## First-Run Checklist (60 Seconds)

Use this as a quick onboarding flow for a fresh setup:

1. Run the platform install script, then start the app and open `http://127.0.0.1:5240`.
2. Go to **Install**:
   - pick a backend that matches your hardware
   - click **Install**
   - verify the top badge changes from `Not Installed` to an installed version
3. Add at least one `.gguf` model to `models/` (or click **Open Models**).
4. Go to **Quick Launch**:
   - keep `API Server` selected unless you specifically want terminal chat
   - choose your model
   - leave the beginner defaults alone or choose a profile
   - click **Launch**
5. If you need deeper control, switch to **Configure**:
   - keep `llama-server` selected for easiest API integration
   - adjust individual flags as needed
6. Confirm it is working:
   - `Running` badge appears in header
   - output panel shows startup logs
   - server address preview appears
   - stats bar appears at the bottom with live token counts and throughput
7. Optional integration check:
   - open the **API** tab
   - copy a snippet and test `/v1/chat/completions`
8. Optional web search check:
   - open the **Chat** tab
   - enable **Web Search**
   - ask a current-events or documentation question
   - confirm the response shows search/reading status and source chips under the answer

If something fails during first run, use **Install -> Repair Install** and then relaunch.

## What Each Tab Does

### Install

- Install/update/repair `llama.cpp` binaries
- Backend and release selectors auto-reflect the installed state
- Quick folder access: **Open Models** and **Open llama.cpp**
- Maintenance action: **Remove llama.cpp Files**
- App updater actions:
  - **Check App Updates**
  - **Update App from GitHub**
- If the app updater says local changes are blocking the update, Windows users can close the app, run `stash-updates.bat` from the Llama GUI folder, then start the app and try **Update App from GitHub** again. This runs `git stash -u`, which saves local changes instead of deleting them.

### Quick Launch

- Beginner-focused launcher for fast first runs
- Shared state with **Configure**, so changes stay in sync between both tabs
- Guided controls for:
  - model selection
  - launch mode (`API Server` or `Chat`)
  - context length
  - GPU offload
  - Auto Fit
  - instruction template packs
  - sampler presets and common sampler values
- Shows the server address and launch command preview before you start

### Configure

- Flag browser with category accordions
- Search across category names, flags, option names, and submenu labels
- `Expand All`, `Collapse All`, and `Clear` controls
- Beginner-oriented descriptions, `More info`, and `Beginner tip`
- Command preview before launch
- **Custom Launch Args** textarea for advanced raw `llama.cpp` flags not yet exposed as UI controls
- Custom args support shell-like quoting, warn when they duplicate UI-managed flags, and block launch if the input cannot be parsed
- Server URL preview when using `llama-server`
- Live server stats bar when running `llama-server`

Default-friendly behavior includes:
- `-fit` set to `on`
- `-c` context default set to `16000`
- `llama-server` selected as the default tool

### Benchmarking

- Run throughput benchmarks with `llama-bench`
- Run perplexity checks with `llama-perplexity`
- Choose settings from **Current Configure**, a **Saved Preset**, or a **Manual Model**
- Shows the command preview, applied settings, excluded settings, and raw benchmark output
- Results are kept only for the current page session
- Uses the same single process slot as normal launches, so stop any running server or chat process before starting a benchmark

### API

- Shows OpenAI-compatible endpoint overview for the current server address
- Provides copy-ready snippets (cURL, Python SDK, JavaScript)
- Useful for quickly connecting local apps/agents to `llama-server`
- Includes an opt-in **Remote Access** panel that starts a Cloudflare tunnel for the Llama GUI control panel only after you click **Start Tunnel**

### Chat

- Built-in chat interface that talks directly to the running `llama-server` via `/v1/chat/completions`
- Streaming responses - tokens appear incrementally as they're generated
- Optional **Web Search** toggle for search-before-answer responses with no user API key or search configuration
- Web Search uses the local Python server to search, fetch public web pages, inject source excerpts into the prompt, and stream the final answer back through the Chat UI
- Source chips appear under web-assisted answers so you can open the pages used for context
- System prompt field in the collapsible right sidebar
- Sampler controls (Temperature, Top-P, Top-K, Min-P, Repeat Penalty, Max Tokens) synced with Quick Launch and Configure
- Undo last message, regenerate last response, and clear chat actions
- Markdown rendering in assistant responses (bold, italic, code blocks, strikethrough)
- Suggestion chips for quick prompts when chat is empty
- Server status badge shows whether `llama-server` is running

### Presets

- Save/load full launcher presets as JSON files in `presets/`
- Import existing preset JSON

## Chat Web Search

The **Web Search** toggle in Chat adds a lightweight search-before-answer flow:

- no API key or user configuration is required
- search runs through the local Python server using the free `ddgs` package
- public web pages from the top results are fetched, cleaned, truncated, and injected as temporary source context
- the normal conversation history stays clean; search result text is not saved as chat messages
- assistant responses still stream token by token, and source chips appear under the final answer

Security and privacy behavior:
- only `http` and `https` URLs are fetched
- private, loopback, link-local, multicast, reserved, and unspecified IP addresses are blocked
- redirects are capped
- fetched page bytes and injected source text are capped to avoid huge prompts

Web Search is best for current or uncertain factual questions. Leave it off for normal local-only chat.

## Sampler Presets

Sampler presets are available in both **Quick Launch** and the **Sampling** section in Configure.

Includes:
- built-in presets: `Neutral`, `Balanced`, `Creative`, `Precise`
- custom preset `Save`, `Load`, `Delete`
- JSON `Import` / `Export`

Current built-ins are tuned to approximate KoboldCpp's simple preset family while keeping the same user-facing preset names:
- `Neutral`: neutralized baseline
- `Balanced`: close to KoboldCpp `Simple Balanced`
- `Creative`: close to KoboldCpp `Simple Creative`
- `Precise`: tuned toward KoboldCpp `Simple Logical`

Storage behavior:
- custom sampler presets are stored in browser `localStorage`
- export creates portable `.json` files
- import accepts single-preset or multi-preset JSON

Quick Launch, Configure, and Chat sampler controls all use the same shared sampler state, so decimal values and preset changes stay synchronized across tabs.

Note: loading a full app preset can overwrite sampler values because samplers are part of the full flag set.

## Server Stats Bar

When `llama-server` is running, a live stats bar appears at the bottom of the screen showing:

- **prompt tokens** - total prompt tokens processed
- **tok/s prompt** - prompt processing throughput
- **gen tokens** - total tokens generated
- **tok/s gen** - generation throughput
- **KV %** - KV cache utilization, or active slot/context occupancy when the running `llama-server` build does not expose a direct KV metric

The bar polls the `/metrics` endpoint every 3 seconds and can fall back to `/slots` for KV/context usage when needed. It disappears when the server stops.

The `--metrics` flag is enabled by default. You can toggle it from:
- **Quick Launch** - "Show server stats bar" checkbox in the Launch Preview card
- **Configure** - "Prometheus Metrics" checkbox in the Server Settings section

Both controls stay in sync.

## MCP and Built-in Tools Notes

Configure has a separate **MCP Settings** section with:
- `--webui-mcp-proxy`
- `--tools` (checklist UI)

For `--tools`:
- high-risk options are visually marked in the UI
- a warning appears when high-risk tools are selected
- use high-risk tools only on trusted/local environments

## Maintenance Behavior

**Remove llama.cpp Files**:
- removes runtime files under `llama/` (`bin`, `grammars`)
- resets installation metadata in `config.json`

It does not remove:
- model files in `models/`
- saved presets in `presets/`

## Project Layout

- `server.py` - compatibility entrypoint that starts the backend app
- `backend/` - local HTTP API, route handlers, service modules, installer/update logic, process manager, HF downloads, web search, remote tunnel, and lifecycle helpers
- `requirements.txt` - Python dependencies, including optional Chat web search support
- `ui/` - static frontend (HTML/CSS/JS)
  - `ui/js/app.js` - app bootstrap, tab switching, launch/stop flow, polling, toasts, and shared orchestration
  - `ui/js/quick-launch-ui.js` - Quick Launch profiles, simplified launch controls, sampler fields, and command preview mirror
  - `ui/js/chat-ui.js` and `ui/js/chat-rendering.js` - Chat state, streaming, conversation history, web search controls, markdown, and message rendering
  - `ui/js/api-tab.js`, `ui/js/hf-download-ui.js`, and `ui/js/remote-tunnel-ui.js` - API snippets, Hugging Face downloads, and Cloudflare tunnel controls
  - `ui/js/sampler-presets.js` - sampler preset storage, import/export, and Configure sampler preset controls
- `llama/bin/` - installed `llama.cpp` executables/runtime files
- `llama/grammars/` - grammar/schema files from release assets
- `models/` - local model files
- `presets/` - saved full launcher presets
- `config.json` - local installation metadata

## Data Locations

- `config.json` - installed release/backend metadata
- `presets/` - full app presets (tool/model/flags)
- browser `localStorage` - custom sampler presets, chat conversations, and Chat Web Search settings

## Troubleshooting

### Port Already In Use

Symptoms:
- app does not start at `http://127.0.0.1:5240`
- server launch fails because target port is occupied

Fix:
- close the app that is already using the port, or
- change the conflicting server/app port and relaunch

### No Model Found / Launch Disabled by Validation

Symptoms:
- launch warns that no model is selected
- model dropdown is empty

Fix:
- place `.gguf` files in `models/`
- click model refresh in Configure
- or set `-hf` / Hugging Face repo flags if you are using remote model loading

### Backend Mismatch (CUDA/Vulkan/SYCL/HIP/Metal/ROCm/OpenVINO)

Symptoms:
- launch crashes immediately
- backend/DLL related errors in output

Fix:
- reinstall with a backend that matches your hardware/drivers
- use **Install -> Repair Install** if runtime files are incomplete
- if unsure, test with `CPU` backend first

### Antivirus/Defender Quarantine

Symptoms:
- install appears successful but binaries are missing
- launch fails with file-not-found or access errors

Fix:
- check antivirus quarantine/history
- restore blocked `llama/` binaries if needed
- add a trusted exclusion for your local project folder (only if you trust the source)

### App Update Buttons Fail or Do Nothing

Symptoms:
- **Check App Updates** or **Update App from GitHub** does not complete as expected

Fix:
- verify `git` is installed and available in PATH
- ensure the repo was cloned with `git clone` (not downloaded as a zip)
- retry from Install tab and review app update status text

### Chat Web Search Does Not Return Results

Symptoms:
- Chat shows a search unavailable or search failed message
- Web-assisted answers have no source chips

Fix:
- rerun the platform install script so `ddgs` is installed from `requirements.txt`
- confirm the machine has internet access
- try a simpler query, since free search providers can occasionally rate-limit or return sparse results
- leave **Web Search** off when you want fully local/offline chat

### Still Stuck

- Open **Output** in Configure and copy the most recent errors.
- Re-run install flow, then try a minimal config (`CPU`, one local model, default flags).
- If needed, share logs plus your backend selection and model name when reporting issues.

## Security Notes

- Llama GUI is intended for local use (`127.0.0.1`).
- `LLAMA_GUI_HOST=0.0.0.0` allows LAN access by IP address, but should only be used on trusted networks or behind a VPN/authenticated reverse proxy. Hostname access requires `LLAMA_GUI_ALLOWED_HOSTS`.
- The wrapper does not enforce its own authentication layer.
- The Cloudflare remote tunnel is opt-in and does not start automatically.
- If exposing beyond localhost, anyone with the tunnel URL can control the running Llama GUI session until you stop the tunnel.
- Be especially careful with `--webui-mcp-proxy` and high-risk `--tools` entries.

## Cross-Platform Notes

- The installer detects the current OS and CPU architecture, then only offers matching prebuilt `llama.cpp` backends.
- Windows keeps the existing `.exe` flow.
- macOS and Linux installs use upstream `.tar.gz` releases and launch native executables without Windows-only assumptions.

## Running Tests

Backend/runtime tests use the Python dependencies from `requirements.txt`:

```bash
python -m unittest discover tests -v
```

Frontend browser smoke tests use dev-only Node dependencies. They are for contributors and CI only; normal app installs, Pinokio launches, and app updates still install only `requirements.txt`.

```bash
npm ci
npx playwright install chromium
npm run test:frontend
```

Tests run automatically on every push and pull request via GitHub Actions. Python tests run across the matrix, and the Playwright smoke test runs once on Ubuntu with Python 3.12.
