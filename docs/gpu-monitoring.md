# GPU monitoring setup

Llama GUI can show per-GPU utilization, memory, and temperature in the **Monitor** tab when a supported telemetry tool is available. GPU monitoring is optional: model launches and the CPU, memory, and disk cards continue to work without it.

## Choose a telemetry tool

| Your system | Recommended starting point |
|---|---|
| NVIDIA on Windows or Linux | `nvidia-smi` from the NVIDIA driver |
| AMD on native Linux with ROCm | `amd-smi` from AMD SMI |
| AMD on Windows | `all-smi` |
| Intel, Apple Silicon, or mixed-vendor GPUs | `all-smi` |
| WSL | `all-smi`, or an already-working vendor tool inside WSL |

`all-smi` is the most flexible option, especially for Windows AMD systems and machines with GPUs from more than one vendor. The native vendor tools remain useful when they already come with your driver or ROCm installation.

After installing or configuring a tool, restart Llama GUI and select **Monitor > Recheck GPU monitoring**.

## NVIDIA: nvidia-smi

`nvidia-smi` is supplied with the NVIDIA display driver and is supported on Windows and Linux. Install or update the driver from the [official NVIDIA driver download](https://www.nvidia.com/Download/index.aspx/), then verify the tool in PowerShell or a terminal:

```text
nvidia-smi
```

Llama GUI checks `PATH` and the standard NVIDIA installation locations. If the command is unavailable after a driver install, restart the computer or confirm that the driver supports the installed GPU.

When Llama GUI runs inside WSL, the Windows NVIDIA driver exposes `nvidia-smi` to the Linux environment with a limited feature set. If the command is not on `PATH`, NVIDIA documents it at `/usr/lib/wsl/lib/nvidia-smi`; add `/usr/lib/wsl/lib` to the WSL `PATH`, then restart Llama GUI. Do not install a Linux display driver inside WSL. See NVIDIA's [nvidia-smi reference](https://docs.nvidia.com/deploy/nvidia-smi/index.html) and [CUDA on WSL guide](https://docs.nvidia.com/cuda/wsl-user-guide/contents.html).

## AMD on Linux: amd-smi

Llama GUI's native AMD SMI adapter is for Linux bare-metal installations. On Windows, use [all-smi](#cross-vendor-all-smi) instead.

First configure AMD's repository and a compatible AMDGPU/ROCm driver for your distribution by following the [AMD SMI installation guide](https://rocm.docs.amd.com/projects/amdsmi/en/latest/install/install.html). AMD SMI is included in many ROCm installations; otherwise install the `amdrocm-amdsmi` package after configuring the repository. For example, on Ubuntu:

```bash
sudo apt install amdrocm-amdsmi
```

The Monitor setup card may show the matching `apt`, `dnf`, or `zypper` command when Llama GUI can identify the distribution. Llama GUI only displays that command; it never installs a package or elevates privileges.

Verify the same command that Llama GUI uses:

```bash
amd-smi metric --json
```

If AMD SMI reports a permissions error, add the user that runs Llama GUI to the `video` and `render` groups, then log out and back in:

```bash
sudo usermod -a -G video,render "$LOGNAME"
```

## Cross-vendor: all-smi

[all-smi](https://github.com/lablup/all-smi) is an optional cross-vendor collector. It is the recommended choice for Windows AMD systems and is also useful for Intel, Apple Silicon, and mixed-vendor machines.

### Install all-smi

Windows:

1. Download the appropriate prebuilt archive from the [all-smi releases page](https://github.com/lablup/all-smi/releases).
2. Extract `all-smi.exe` to a stable location.
3. Either add that directory to `PATH`, or set `LLAMA_GUI_ALL_SMI_PATH` as shown below.

macOS or Linux with Homebrew:

```bash
brew tap lablup/tap
brew install all-smi
```

Ubuntu with the project PPA:

```bash
sudo add-apt-repository ppa:lablup/backend-ai
sudo apt update
sudo apt install all-smi
```

See the upstream [all-smi README](https://github.com/lablup/all-smi#installation) for current packages and platform requirements. On Linux, AMD telemetry may also require the AMD driver libraries and access to `/dev/dri` through the `video` and `render` groups.

Verify that all-smi returns schema-1 JSON with a `gpus` list:

```text
all-smi snapshot --format json --include gpu
```

If `all-smi` is on the `PATH` seen by Llama GUI, no further configuration is needed.

### Use a portable all-smi executable

Set the executable path before starting Llama GUI. This is useful when a desktop shortcut, service, or launcher has a different `PATH` from your terminal.

PowerShell:

```powershell
$env:LLAMA_GUI_ALL_SMI_PATH = "C:\Tools\all-smi\all-smi.exe"
python server.py
```

macOS or Linux:

```bash
export LLAMA_GUI_ALL_SMI_PATH="/opt/all-smi/all-smi"
python server.py
```

Environment variables set this way apply to that terminal session. If Llama GUI normally starts from a shortcut or service, configure the same variable in that launcher or as a persistent user environment variable.

### Use a local all-smi API

For an all-smi process that stays running, start its local API:

```text
all-smi api --port 9090
```

Then set its loopback origin before starting Llama GUI:

PowerShell:

```powershell
$env:LLAMA_GUI_ALL_SMI_URL = "http://127.0.0.1:9090"
python server.py
```

macOS or Linux:

```bash
export LLAMA_GUI_ALL_SMI_URL="http://127.0.0.1:9090"
python server.py
```

Llama GUI reads only the local `/snapshot?include=gpu` endpoint. For safety, the URL must use plain HTTP on `localhost`, `127.0.0.0/8`, or `::1`; credentials, redirects, proxies, and remote hosts are rejected. `LLAMA_GUI_ALL_SMI_URL` takes priority over `LLAMA_GUI_ALL_SMI_PATH` and `PATH` discovery.

## How Llama GUI chooses a collector

At startup and on **Recheck GPU monitoring**, Llama GUI tries these sources in order:

1. `LLAMA_GUI_ALL_SMI_URL`, when set.
2. `LLAMA_GUI_ALL_SMI_PATH`, when set.
3. `all-smi` on `PATH`.
4. The native `nvidia-smi` and Linux `amd-smi` probes.

A successful all-smi snapshot is authoritative, which prevents the same GPU from appearing twice. If all-smi is missing, fails, or reports no usable GPUs, Llama GUI still tries the native vendor tools. Unsupported fields remain **Not available** rather than being shown as zero.

## Troubleshooting

- Restart Llama GUI after changing `PATH`, installing a driver or package, or setting an environment variable. Then use **Recheck GPU monitoring**.
- Run the verification command as the same operating-system user that starts Llama GUI.
- If a command works in your terminal but not in Llama GUI, the launcher probably has a different `PATH`. Configure `LLAMA_GUI_ALL_SMI_PATH`, or add the tool to the launcher's environment.
- Read the probe details in the Monitor card. Llama GUI reports the tool path and whether the probe was missing, timed out, exited with an error, returned invalid output, or found no usable devices.
- Partial telemetry is normal on some hardware and drivers. A card can still be useful when temperature or dedicated-memory data is unavailable.
- The all-smi API integration is local-only. all-smi's remote-view features do not make a remote endpoint eligible for `LLAMA_GUI_ALL_SMI_URL`.

