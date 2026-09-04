# Troubleshooting

Back to the [README](../README.md).

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

## App update buttons fail

Need `git` on PATH and a git clone (not a zip extract). Retry from Install and read the update status text.

## Chat Web Search fails

Rerun the platform install script so `ddgs` is present; check internet access; try a simpler query (free providers rate-limit). Leave Web Search off for offline chat.

## Still stuck

Copy recent errors from the live process output on the **Monitor** tab. Retry a minimal setup (`CPU`, one local model, defaults). Include logs, backend, and model name when reporting issues.
