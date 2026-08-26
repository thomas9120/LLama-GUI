# TODO

## Investigate the `llama-cli` conversation flag

- The Configure tab defines **Conversation Mode** as the CLI-only `-cnv` flag.
- It is visible only after selecting **llama-cli (Interactive Chat)** and expanding **Conversation & Chat**, so it is easy to overlook during normal `llama-server` use.
- The installed llama.cpp build `b10630` advertises neither `-cnv` nor `--conversation` and rejects both as invalid arguments.

### Upstream context

- On December 10, 2025, [llama.cpp PR #17824](https://github.com/ggml-org/llama.cpp/pull/17824) replaced the old completion-oriented `llama-cli` with a server-backed chat CLI and renamed the old implementation `llama-completion`.
- Current `llama-cli` enters an interactive chat loop unconditionally in [`tools/cli/cli-context.cpp`](https://github.com/ggml-org/llama.cpp/blob/master/tools/cli/cli-context.cpp) and sends requests through `/v1/chat/completions`; it has no raw-completion mode.
- `-cnv` and `-no-cnv` remain argument options for `llama-completion`, where they control `COMMON_CONVERSATION_MODE`, but are registered for `LLAMA_EXAMPLE_COMPLETION` rather than `LLAMA_EXAMPLE_CLI`.
- Current `llama-cli` supports `-st` / `--single-turn`, which exits after one chat response. This is not equivalent to disabling conversation formatting.
- Upstream documentation is inconsistent: [`tools/cli/README.md`](https://github.com/ggml-org/llama.cpp/blob/master/tools/cli/README.md) still documents `-cnv` and `-no-cnv`, while [issue #27214](https://github.com/ggml-org/llama.cpp/issues/27214) reports that `-no-cnv` can be accepted without changing behavior, leaving scripted callers waiting at the chat prompt.

### Later decision

- Remove **Conversation Mode** from current `llama-cli`, or gate it to pre-PR-#17824 builds if those builds must remain supported.
- If Llama GUI later adds `llama-completion` as a tool, expose `-cnv` / `-no-cnv` there instead.
- Keep `-st` as the supported current `llama-cli` control for a single-response session.
