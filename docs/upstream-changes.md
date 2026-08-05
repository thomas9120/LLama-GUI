# Upstream Changes

Track announced llama.cpp changes that may require coordinated Llama-GUI updates. Remove an entry after the local change is completed or deliberately declined.

## Pending

### llama-server default port: 8080 to 9931

- **Upstream:** [ggml-org/llama.cpp#26508](https://github.com/ggml-org/llama.cpp/pull/26508)
- **Status:** The advance-warning notice merged on 2026-08-03; the actual default-port change is still pending.
- **Current impact:** None. Llama-GUI explicitly launches `llama-server` with `--port 8080`.
- **Recheck when:** Upstream changes the actual default or a bundled llama.cpp release includes that change.
- **Local decision:** Either keep Llama-GUI's explicit 8080 default or change the frontend, backend target fallback, external-server form, tests, and documentation to 9931 together.

Last checked: 2026-08-04.
