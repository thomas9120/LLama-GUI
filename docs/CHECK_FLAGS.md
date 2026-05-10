# CHECK_FLAGS.md

Agent reference for auditing `ui/js/flags.js` against upstream `llama.cpp` and reporting findings.

## Purpose

When asked to check for flag changes, additions, removals, deprecations, or chat-template changes, compare the local GUI flag definitions against current upstream `llama.cpp` and produce a structured markdown report.

Do not modify `ui/js/flags.js` during the audit unless the user explicitly asks for implementation. A report file is fine when requested.

## Files To Check

### Local

| File | Role |
|---|---|
| `ui/js/flags.js` | Single source of truth for all CLI flags exposed in the UI |
| `ui/js/app.js` | Shared setter/state and launch-arg generation logic that consumes `FLAGS` |

### Upstream

| URL | What to extract |
|---|---|
| `https://api.github.com/repos/ggerganov/llama.cpp/commits/master` | Current master commit SHA for a pinned report |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/common/arg.cpp` | Primary source for registered CLI flags, aliases, descriptions, defaults, enum values, examples, excludes, and deprecation notes |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/common/arg.h` | Parser structs and constructor shapes; useful for understanding `common_arg` forms |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/tools/server/server.cpp` | Sanity check for server-only flags outside the common parser |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/examples/server/README.md` | Server usage notes and documented behavior |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/src/llama-chat.cpp` | Built-in chat template registry (`LLM_CHAT_TEMPLATES`) |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/common/chat.cpp` | Chat template behavior and fallback logic |

Note: `src/chat.cpp` may not exist in current upstream. Prefer `src/llama-chat.cpp` for built-in template names.

## Efficient Workflow

### 1. Pin upstream

Fetch the upstream master commit first and include the SHA in the report. This makes the audit reproducible even if master changes later.

### 2. Parse local `FLAGS`

Use a JavaScript runtime instead of regex-only parsing so shared constants like `CHAT_TEMPLATE_PRESET_OPTIONS` resolve correctly.

Example shape:

```js
const fs = require("fs");
const vm = require("vm");

const src = fs.readFileSync("ui/js/flags.js", "utf8")
  + "\nthis.__out={FLAGS,BUILTIN_CHAT_TEMPLATES,CHAT_TEMPLATE_PRESETS,FLAG_CATEGORIES};";
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const { FLAGS, BUILTIN_CHAT_TEMPLATES, CHAT_TEMPLATE_PRESETS } = ctx.__out;
```

Extract:

- `id`
- `flag`
- `false_flag`
- `type`
- `default`
- `options`
- `tool`
- `desc`

Also count and compare `BUILTIN_CHAT_TEMPLATES` and `CHAT_TEMPLATE_PRESETS`.

### 3. Parse upstream flags

Parse `common/arg.cpp` for `common_arg(...)` registrations. `arg.h` defines the constructors, but `arg.cpp` is the practical source for the flag table.

For each `common_arg(...)`, extract:

- all aliases from the first argument list, such as `{"-c", "--ctx-size"}`
- negation aliases from a second alias list, such as `{"--no-mmap"}`
- value hint, if present
- help text, including `string_format(...)` text
- `.set_examples(...)` and `.set_excludes(...)`
- `.set_env(...)`
- handler type hints, such as `handler_int`, string parsing, bool setter, or explicit enum validation

Use `set_examples` / `set_excludes` to decide tool scope:

- includes `LLAMA_EXAMPLE_SERVER`: server
- common/no server exclusion: server-relevant
- includes or defaults to main/common: cli/common
- if both server and cli/common apply, report `both`

Filter out utility/meta flags unless the GUI intends to expose them, for example `--help`, `--usage`, `--version`, `--license`, and shell completion flags.

### 4. Match flags

Match by all known aliases, not just the local `flag` field.

Rules:

1. Exact long-form match: `--ctx-size` matches `--ctx-size`.
2. Shorthand match: local `-c` matches upstream `{"-c", "--ctx-size"}`.
3. Negation match: local `false_flag: "--no-mmap"` matches upstream `{"--mmap"}, {"--no-mmap"}`.
4. Canonical-renamed bools: if local uses a negation alias that upstream still accepts, report it as a rename/cleanup, not a removal.
5. Option additions count as changed flags, not new flags. Example: upstream adding `tensor` to `--split-mode`.

### 5. Compare and categorize

#### A. New upstream flags not in `flags.js`

Report upstream server/common flags that have no local alias match.

For each high-signal flag include:

- flag and shorthand
- rough type
- upstream default, when easily available
- description
- tool scope
- suggested `FLAG_CATEGORIES` category

For large unmatched sets, summarize by category and list the highest-value candidates rather than dumping every niche flag into a huge table.

#### B. Local flags missing from upstream

Report local flags that have no upstream alias match.

Before calling a flag removed, check whether it is still accepted as:

- a negation alias
- a secondary alias
- a renamed canonical flag
- a server-only option

#### C. Changed flags

Check:

| Property | What to compare |
|---|---|
| Shorthand | Added, removed, or changed aliases |
| Type | int, float, bool, string, enum, multi-value |
| Default | Upstream default vs local default |
| Enum options | Added, removed, renamed options |
| Description | Significant behavior changes |
| Deprecation | Warnings or deprecation notes in handler/help text |

Important: local defaults may intentionally differ as GUI safe defaults. Still report them, because this app initializes `flagValues` from `getDefaultValues()` and launch args may emit those values.

#### D. Chat template changes

Compare local `BUILTIN_CHAT_TEMPLATES` against upstream `LLM_CHAT_TEMPLATES` in `src/llama-chat.cpp`.

Report:

- new upstream built-ins missing locally
- local built-ins no longer upstream
- likely renamed templates

Remember: `BUILTIN_CHAT_TEMPLATES` is a compatibility allowlist. New upstream templates do not automatically need curated dropdown presets unless they map to a user-facing preset.

#### E. Other server features

Scan `tools/server/server.cpp` and `examples/server/README.md` for `--flag` strings not found in `common/arg.cpp`. If none are found, state that.

## Category Mapping Guide

| Category | Keywords |
|---|---|
| `model` | model loading, HF repo, mmproj, image, vocoder, docker repo, model URL |
| `context` | context size, batch, memory, cache RAM, mmap, mlock, SWA, checkpoints |
| `cpu` | threads, NUMA, CPU affinity, priority, polling |
| `gpu` | GPU layers, device, flash attention, offload, split, tensor, fit, RPC |
| `sampling` | temperature, top-k, top-p, min-p, penalties, samplers, DRY, XTC, mirostat, logit bias |
| `rope` | RoPE, YaRN, frequency, scaling |
| `conversation` | chat, template, jinja, prompt, system, reasoning, prefill |
| `lora` | LoRA, control vector, adapter |
| `kv` | KV cache type, cache quantization, context shift, unified KV |
| `speculative` | speculative, draft, n-gram speculation |
| `server` | host, port, API key, SSL, parallel, batching, timeout, metrics, WebUI, MCP, tools, embedding, slots, rerank |
| `grammar` | grammar, JSON schema, constraints, sampling backend |
| `logging` | verbose, log, timestamps, colors, timings |
| `advanced` | override, tensor check, warmup, offline, host buffer, shortcut presets |

## Output Format

Use this structure for the report:

```md
# Flag Audit Report - [date]

**Upstream ref:** `ggerganov/llama.cpp` master at `[commit]`
**Local FLAGS count:** [N]
**Upstream server/common flag count parsed:** [M]

## A. New Upstream Flags

[Summary table of high-signal additions plus grouped count summary.]

## B. Removed/Renamed Upstream Flags

[Table or "No changes found."]

## C. Changed Flags

[Table of changed aliases, defaults, enum options, types, descriptions, and deprecations.]

## D. Chat Template Changes

[Added/removed/renamed templates.]

## E. Other Server Features

[Server-only flags found outside common parser, or "No changes found."]

## Summary

- [N] upstream flags not exposed locally
- [M] local flags to remove/remap
- [K] notable changed flags
- [T] template changes
```

## Current Known Patterns

These examples came up in a recent audit and are useful as calibration points:

- `--no-mmproj` is still accepted upstream, but the canonical positive flag is now `--mmproj-auto` with negations `--no-mmproj` / `--no-mmproj-auto`.
- `--split-mode` currently accepts `none`, `layer`, `row`, and `tensor`; local UI may lag by missing `tensor`.
- `--tools` currently includes `get_datetime`; local UI may lag by missing it.
- `src/llama-chat.cpp` currently contains the built-in template map, not `src/chat.cpp`.
- `common/arg.cpp` can contain more than 100 upstream server/common flags that the GUI does not expose. Treat this as a curated-surface decision unless a flag is user-facing, newly important, or affects an already exposed control.

## Reminders

- Prefer `rg` for local search.
- Keep the audit read-only unless the user asks for edits.
- Always include the upstream commit SHA.
- Report default differences even if they are intentional.
- Do not add every upstream flag automatically. Prioritize flags that affect existing controls, user-visible launch behavior, compatibility, security, or common server workflows.
