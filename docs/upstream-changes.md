# Upstream Changes

Track announced llama.cpp changes that may require coordinated Llama-GUI updates. Remove an entry after the local change is completed or deliberately declined.

## Pending

### Native reasoning-effort support

- **Upstream:** [ggml-org/llama.cpp#26941](https://github.com/ggml-org/llama.cpp/pull/26941), merged on 2026-08-14 as commit `7e4c0a9`.
- **Status:** Merged into llama.cpp `master`, but the Llama-GUI workspace's current bundled binary is build `10375` (`ba360efe1`) and does not yet advertise `--reasoning-effort` in `llama-server --help`.
- **Why this matters:** Llama-GUI currently sets its server-wide default with `--chat-template-kwargs {"reasoning_effort":"..."}` and sends per-chat effort levels through request `chat_template_kwargs`. This works across older and newer llama.cpp builds, but ordinary OpenAI-compatible harnesses such as OpenCode normally send top-level `reasoning_effort`; older llama.cpp builds ignored every top-level value except `none`.
- **New upstream behavior:**
  - `--reasoning-effort LEVEL` is now a native `llama-server`, `llama-cli`, and `llama-completion` launch option. Upstream documents `default`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `default` leaves the template default unchanged.
  - Top-level Chat Completions `reasoning_effort` is now made available to the Jinja template. `none` disables reasoning. This lets standard harness reasoning selectors work without custom request-body variants when the loaded template supports effort levels.
  - `/props` now includes `chat_template_caps.supports_reasoning_effort`. This is a boolean capability only; it does not enumerate the effort names accepted by a particular model.
  - The Jinja capability layer also supplies the value as `reasoning_strength` for model-specific templates such as Muse Glimmer.
- **Precedence after the merge:** Server defaults are the base, request `chat_template_kwargs.reasoning_effort` overrides that base, and top-level request `reasoning_effort` has final precedence. Therefore, a harness request for `medium` should override a server launch default of `xhigh`.
- **Current compatibility decision:** Keep emitting the server default through `--chat-template-kwargs` until the bundled/downloaded llama.cpp build advertises the native flag. The kwargs form remains supported upstream and avoids making current binaries reject the launch command.
- **Planned local migration:**
  1. After the supported binary floor includes `7e4c0a9`, change the server-wide **Default Reasoning Effort** control to emit native `--reasoning-effort LEVEL`; Auto should continue omitting an override rather than disabling reasoning.
  2. Stop combining reasoning effort with the legacy Preserve Thinking JSON. Preserve Thinking can remain on its own `--chat-template-kwargs` compatibility path, allowing the duplicate-flag exception and special combined serializer to be removed.
  3. Send the Chat sidebar's Low/Medium/High/XHigh choice as top-level `reasoning_effort`. During the older-build compatibility window, also retain the matching nested `chat_template_kwargs` fallback; Off should continue sending `reasoning_effort: "none"` and the nested disable fallback.
  4. Consider consuming `chat_template_caps.supports_reasoning_effort` after server startup to explain or disable effort controls for unsupported templates. Keep the model-specific warning because the capability does not reveal whether `high`, `xhigh`, or another level is valid.
- **Validation before removing fallbacks:** Confirm the selected llama.cpp binary exposes `--reasoning-effort`; test Auto and every Llama-GUI level in command generation; verify server XHigh plus request Medium resolves to Medium; exercise Llama-GUI Chat, a raw OpenAI-compatible request, and OpenCode's ordinary effort selector; compare visibly different levels on Qwen3.8 and at least one model that supports High; and confirm Preserve Thinking still produces one valid launch argument.
- **Upstream caution:** [ggml-org/llama.cpp#27023](https://github.com/ggml-org/llama.cpp/issues/27023) remains open and reports Low/High having no effect on some models in an earlier build. Smoke-test a post-merge binary before treating the native path as the sole implementation.

### llama-server default port: 8080 to 9931

- **Upstream:** [ggml-org/llama.cpp#26508](https://github.com/ggml-org/llama.cpp/pull/26508)
- **Status:** The advance-warning notice merged on 2026-08-03; the actual default-port change is still pending.
- **Current impact:** None. Llama-GUI explicitly launches `llama-server` with `--port 8080`.
- **Recheck when:** Upstream changes the actual default or a bundled llama.cpp release includes that change.
- **Local decision:** Either keep Llama-GUI's explicit 8080 default or change the frontend, backend target fallback, external-server form, tests, and documentation to 9931 together.

Last checked: 2026-08-14.
