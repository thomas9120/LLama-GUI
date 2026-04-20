# Llama GUI

Lightweight local launcher and control panel for `llama.cpp` on Windows, macOS, and Linux.

Llama GUI provides a browser UI to:
- install prebuilt `llama.cpp` releases by backend (CPU/CUDA/Vulkan/SYCL/HIP)
- use a beginner-friendly **Quick Launch** tab for fast startup
- configure and launch `llama-server` or `llama-cli`
- monitor process output in real time
- use OpenAI-compatible endpoint helpers/snippets
- manage full launch presets and sampler presets
- manage local app updates from GitHub

## Requirements

- Python 3.9+
- Internet access (for release metadata/downloads and optional app updates)
- A supported OS/architecture for the prebuilt `llama.cpp` binaries you want to install

Supported prebuilt backends vary by platform:
- Windows: CPU, CUDA, Vulkan, SYCL, HIP
- macOS: Apple Silicon (`Metal`, optional `KleidiAI`) and Intel CPU builds
- Linux: CPU, Vulkan, ROCm, OpenVINO (depends on architecture)

## Quick Start

1. Start the app:

```bash
python3 server.py
```

Platform launch helpers:
- Windows: `windows_start.bat` or `windows_startsilent.bat`
- macOS/Linux: `./start.sh` or `./start_silent.sh`

2. Open `http://127.0.0.1:5240` in your browser.
3. In **Install**, choose a version + backend, then click **Install**.
4. Put `.gguf` files in `models/` (or click **Open Models**).
5. In **Quick Launch**, select a model, keep the beginner defaults or choose a profile, and click **Launch**.
6. Use **Configure** when you want full flag-by-flag control.

## Download the Current Release Zip

If you do not want to clone the repository, you can download the latest packaged release from the GitHub **Releases** page.

### Windows

1. Open the latest release on GitHub.
2. Download the packaged zip asset such as `Llama-GUI-v0.1.0.zip`.
3. Right-click the zip and choose **Extract All...**
4. Open the extracted folder.
5. Start the app with:
   - `windows_start.bat`
   - or `windows_startsilent.bat`
6. Open `http://127.0.0.1:5240` in your browser.

### macOS / Linux

1. Open the latest release on GitHub.
2. Download the packaged zip asset such as `Llama-GUI-v0.1.0.zip`.
3. Extract it with your file manager or a command like:

```bash
unzip Llama-GUI-v0.1.0.zip
cd Llama-GUI-v0.1.0
```

4. Make the helper scripts executable if needed:

```bash
chmod +x start.sh start_silent.sh
```

5. Start the app with:
   - `python3 server.py`
   - or `./start.sh`
   - or `./start_silent.sh`
6. Open `http://127.0.0.1:5240` in your browser.

Note: the packaged release zip does not include downloaded `llama.cpp` binaries or local models. After starting the app, use the **Install** tab to download a backend and then place your `.gguf` files in `models/`.

## Install By Platform

### Windows

1. Install Python 3.9+ from [python.org](https://www.python.org/downloads/) and make sure it is available in `PATH`.
2. Clone or download this repository.
3. Start the app with one of:
   - `python server.py`
   - `windows_start.bat`
   - `windows_startsilent.bat`
4. Open `http://127.0.0.1:5240` in your browser.
5. In the **Install** tab, choose a Windows backend such as `CPU`, `CUDA`, `Vulkan`, `SYCL`, or `HIP`, then click **Install**.
6. Go to **Quick Launch** for the simplest first run, or **Configure** for full manual tuning.

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
chmod +x start.sh start_silent.sh
```

4. Start the app with one of:
   - `python3 server.py`
   - `./start.sh`
   - `./start_silent.sh`
5. Open `http://127.0.0.1:5240` in your browser.
6. In the **Install** tab, choose the backend that matches your Mac:
   - Apple Silicon: `Metal` or `Metal + KleidiAI`
   - Intel Mac: `CPU`
7. Go to **Quick Launch** for the simplest first run, or **Configure** for full manual tuning.

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
chmod +x start.sh start_silent.sh
```

4. Start the app with one of:
   - `python3 server.py`
   - `./start.sh`
   - `./start_silent.sh`
5. Open `http://127.0.0.1:5240` in your browser.
6. In the **Install** tab, choose a Linux backend supported by your machine, such as `CPU`, `Vulkan`, `ROCm`, or `OpenVINO`.
7. Go to **Quick Launch** for the simplest first run, or **Configure** for full manual tuning.

Note: some Linux accelerator backends may also require vendor drivers or runtime packages outside of Llama GUI itself.

## First-Run Checklist (60 Seconds)

Use this as a quick onboarding flow for a fresh setup:

1. Start `python3 server.py` (or use the platform helper script) and open `http://127.0.0.1:5240`.
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
7. Optional integration check:
   - open the **API** tab
   - copy a snippet and test `/v1/chat/completions`

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
- Server URL preview when using `llama-server`

Default-friendly behavior includes:
- `-fit` set to `on`
- `-c` context default set to `16000`
- `llama-server` selected as the default tool

### API

- Shows OpenAI-compatible endpoint overview for the current server address
- Provides copy-ready snippets (cURL, Python SDK, JavaScript)
- Useful for quickly connecting local apps/agents to `llama-server`

### Presets

- Save/load full launcher presets as JSON files in `presets/`
- Import existing preset JSON

## Suggested README Screenshots

If you want stronger onboarding for new users, adding these screenshots helps a lot:

1. **Install tab** after successful install (version badge + backend selected)
2. **Quick Launch tab** with a model selected and the preview card visible
3. **Configure tab** with model selected + launch bar visible
4. **API tab** showing base URL + sample snippet cards
5. **Server and MCP Settings** submenu expanded (including risk badges/warning)
6. **Output panel** showing successful `llama-server` startup logs

## Sampler Presets

Sampler presets are available in both **Quick Launch** and the **Sampling** section in Configure.

Includes:
- built-in presets: `Balanced`, `Creative`, `Precise`
- custom preset `Save`, `Load`, `Delete`
- JSON `Import` / `Export`

Storage behavior:
- custom sampler presets are stored in browser `localStorage`
- export creates portable `.json` files
- import accepts single-preset or multi-preset JSON

Note: loading a full app preset can overwrite sampler values because samplers are part of the full flag set.

## MCP and Built-in Tools Notes

The Server settings include a **Server and MCP Settings** submenu with:
- `--webui-mcp-proxy`
- `--tools` (checklist UI)

For `--tools`:
- high-risk options are visually marked in the UI
- a warning appears when high-risk tools are selected
- use high-risk tools only on trusted/local environments

## Maintenance Behavior

**Remove llama.cpp Files**:
- removes runtime files under `llama/` (`bin`, `dll`, `grammars`)
- resets installation metadata in `config.json`

It does not remove:
- model files in `models/`
- saved presets in `presets/`

## Project Layout

- `server.py` - local HTTP API, installer/update logic, process manager
- `ui/` - static frontend (HTML/CSS/JS)
- `llama/bin/` - installed `llama.cpp` executables/runtime files
- `llama/dll/` - optional extra runtime library folder kept for compatibility
- `llama/grammars/` - grammar/schema files from release assets
- `models/` - local model files
- `presets/` - saved full launcher presets
- `config.json` - local installation metadata

## Creating a GitHub Release Asset

If you want a clean zip to upload to **GitHub Releases**, use the Windows packaging helper:

```bat
release.bat v0.1.0
```

This creates a zip in `releases/` named like:

```text
Llama-GUI-v0.1.0.zip
```

The generated zip includes the app itself:
- `server.py`
- `ui/`
- `start.sh`
- `start_silent.sh`
- `windows_start.bat`
- `windows_startsilent.bat`
- `README.md`
- `LICENSE`
- empty starter folders for `llama/`, `models/`, and `presets/`

It does not include local-only data such as:
- `.git/`
- installed `llama.cpp` binaries
- local models
- saved presets
- `config.json`
- Python cache folders

GitHub will already provide automatic source-code archives for your tag, so this zip is best used as the cleaner end-user download asset.

## Data Locations

- `config.json` - installed release/backend metadata
- `presets/` - full app presets (tool/model/flags)
- browser `localStorage` - custom sampler presets

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
- ensure the repo folder has normal Git metadata (not a broken or partial clone)
- retry from Install tab and review app update status text

### Still Stuck

- Open **Output** in Configure and copy the most recent errors.
- Re-run install flow, then try a minimal config (`CPU`, one local model, default flags).
- If needed, share logs plus your backend selection and model name when reporting issues.

## Security Notes

- Llama GUI is intended for local use (`127.0.0.1`).
- The wrapper does not enforce its own authentication layer.
- If exposing beyond localhost, add network hardening and auth first.
- Be especially careful with `--webui-mcp-proxy` and high-risk `--tools` entries.

## Cross-Platform Notes

- The installer detects the current OS and CPU architecture, then only offers matching prebuilt `llama.cpp` backends.
- Windows keeps the existing `.exe` flow.
- macOS and Linux installs use upstream `.tar.gz` releases and launch native executables without Windows-only assumptions.
