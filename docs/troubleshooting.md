# Troubleshooting

Back to the [README](../README.md).

## Llama GUI crashes or disappears

Llama GUI automatically creates a timestamped `llama-gui-*.log` file in the
checkout's `logs/` folder on every launch. No debug option or special launcher is
needed. The log path is printed in the server terminal. After a crash, keep the
file from that run; restarting creates a new file rather than overwriting it.
The 10 newest session logs are retained, with older ones removed at startup when
possible. Files are not rotated during a running session so native crash reporting
can keep using the same open file descriptor.

Logs include UTC timestamps, Python/runtime details, backend stderr messages,
uncaught Python exceptions (including background threads), and native crash
tracebacks when Python's fault handler can report them. Normal server shutdowns
record the exit code. Existing console error output is preserved. This also works
for silent launches, GUI restarts, and Pinokio's `server.py` entrypoint.

These are GUI-server diagnostics; llama.cpp subprocess output remains in
**Monitor**. Logs are local files and may contain paths and error details, so
review them before sharing. If the log directory is unwritable, the server warns
in its terminal and continues without file logging. A forced process kill, power
loss, or hang may leave no final traceback; absence of a shutdown entry alone
does not identify the cause.

## Port already in use

App does not start at `http://127.0.0.1:5240`, or server launch fails on a taken port. Close the conflicting app or change its port.

## No model / launch validation disabled

Place `.gguf` files in the active models folder, refresh the model list in Configure, reset an unavailable custom folder, or use `-hf` / HF repo flags for remote loading.

## Backend mismatch (CUDA/Vulkan/SYCL/Metal/ROCm/OpenVINO)

Immediate crash or DLL/backend errors: reinstall a backend that matches your hardware/drivers, try **Install → Repair Install**, or test with `CPU` first.

On Linux, Llama GUI uses `ldd` when available to check `llama-server`, `llama-cli`, and packaged ggml backend plugins before launch, then reports unresolved shared libraries in the Install tab. If a repaired Vulkan or ROCm install still fails, verify the host driver stack directly:

```bash
ldd llama/bin/llama-server | grep "not found"
vulkaninfo --summary   # Vulkan
rocminfo               # ROCm / AMD kernel-driver access
```

Lemonade ROCm archives include user-space ROCm libraries, but the selected `gfx` target must match the GPU and the host still needs working AMD kernel-driver access. If model loading runs unusually long, the app keeps the process stoppable and adds a persistent warning directing you to the live process output.

## Antivirus / Defender quarantine

Install looks fine but binaries are missing: check quarantine, restore blocked `llama/` files, and only add a project exclusion if you trust the source.

## Windows CUDA updates stop at b10976

Upstream Windows x64 releases switched from CUDA 13.3 to 13.4 in
[b10978](https://github.com/ggml-org/llama.cpp/releases/tag/b10978).
In **Install**, select **CUDA 13.4 (NVIDIA)**, choose a release, and click
**Install**. Existing CUDA 13.3 configurations remain supported for older builds;
the backend update button stays within the installed CUDA version. Both the binary
and matching CUDA runtime archive must be available before a release can be installed.

## App update buttons fail

Need `git` on PATH and a git clone (not a zip extract). Retry from Install and read the update status text.

## Chat Web Search fails

Rerun the platform install script so `ddgs` is present; check internet access; try a simpler query (free providers rate-limit). Leave Web Search off for offline chat.

## Still stuck

Copy recent errors from the live process output on the **Monitor** tab. Retry a minimal setup (`CPU`, one local model, defaults). Include logs, backend, and model name when reporting issues.
