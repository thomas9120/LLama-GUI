# Security Notes

Back to the [README](../README.md).

- Intended for local use (`127.0.0.1`). The wrapper does not enforce its own authentication layer.
- Optional llama-server **API Key** in Quick Launch/Configure adds `--api-key`; leave blank for open-access. Built-in Chat and stats proxies use the key when set; previews, output, presets, and exports redact/omit it. The key protects llama-server endpoints only — not the Llama GUI management UI — and may be visible to same-user process inspection (CLI argument).
- `LLAMA_GUI_HOST=0.0.0.0` is for trusted networks / VPN / authenticated reverse proxies only. Hostname access needs `LLAMA_GUI_ALLOWED_HOSTS`.
- Cloudflare tunnel is opt-in and does not auto-start. Anyone with the tunnel URL can control the running session until you stop it.
- The chat and metrics proxies only ever target a `llama-server` this GUI launched or one registered through the API tab; the destination is never taken from the chat request itself. Registration accepts loopback and this machine's own interfaces only — but, like the rest of the control panel, the registration endpoint is available to anyone who can reach the GUI, so a tunnel visitor can re-point the proxy at another port on the host machine.
- A registered server's API key is held in memory for the session, never written to `config.json` and never included in any API response. Only the address is remembered between sessions, and it is re-registered on startup only when no key was needed and the port still answers as `llama-server` — so a port taken over by some other local service is refused rather than silently proxied to.
- Be careful with `--ui-mcp-proxy` and high-risk `--tools`.
- Web Search only fetches `http`/`https`, blocks private/loopback/link-local/multicast/reserved addresses, caps redirects, and limits fetch size and injected context.
