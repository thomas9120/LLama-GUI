# CHECK_FLAGS.md

Agent reference for auditing `ui/js/flags.js` against upstream `llama.cpp` and reporting findings.

---

## Purpose

When the user asks to check for flag changes, additions, removals, or deprecations, follow the workflow below to compare the local flag definitions against the current upstream `llama.cpp` source and produce a structured findings report.

---

## Source Files To Check

### Local (this project)

| File | Role |
|---|---|
| `ui/js/flags.js` | Single source of truth for all CLI flags exposed in the UI |
| `ui/js/app.js` | Shared setter/state logic that consumes the flags |

### Upstream (llama.cpp)

| URL | What to extract |
|---|---|
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/common/arg.h` | Full list of CLI flags, types, shorthands, defaults |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/common/arg.cpp` | Descriptions, enum values, default values, deprecation info |
| `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/examples/server/README.md` | Server-specific flags, descriptions, usage notes |

When `arg.h`/`arg.cpp` are insufficient, also check:
- `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/tools/server/server.cpp` (for server-only flags)

---

## Workflow

### Step 1 - Fetch upstream flag definitions

1. Fetch `arg.h` to extract the complete flag table. Every `llama_arg` entry defines:
   - Long form(s): `--flag-name`
   - Short form(s): `-x`
   - Value type: `int`, `float`, `bool`, `string`, `enum`
   - Whether it is a `llama_server` flag, `llama_cli` flag, or both
2. Fetch `arg.cpp` to get descriptions, enum option lists, and default values.
3. Fetch `examples/server/README.md` for any server-only flags documented there but missing from `arg.h`.

### Step 2 - Parse the local FLAGS array

Read `ui/js/flags.js` and extract from the `FLAGS` array:

- `id` — internal identifier
- `flag` — primary CLI flag string (e.g. `"--temp"`, `"-c"`)
- `false_flag` — negation flag for bools (e.g. `"--no-mmap"`)
- `type` — `"int"`, `"float"`, `"bool"`, `"text"`, `"path"`, `"enum"`, `"multi_enum"`
- `default` — default value
- `options` — enum option list
- `tool` — `"both"`, `"server"`, or `"cli"`
- `desc` — description text

Also extract `BUILTIN_CHAT_TEMPLATES` and `CHAT_TEMPLATE_PRESETS` for template auditing.

### Step 3 - Compare and categorize

For each upstream flag, check whether it exists in the local `FLAGS` array. For each local flag, check whether it still exists upstream.

Categorize findings into these groups:

#### A. New upstream flags not in `flags.js`

Flags present in upstream `arg.h`/`arg.cpp` that have no matching entry in `FLAGS`.

Report for each:
- Flag name and shorthand
- Type and default value
- Description from upstream
- Whether it applies to `server`, `cli`, or `both`
- Suggested `category` from `FLAG_CATEGORIES` based on its function

#### B. Flags in `flags.js` missing from upstream

Flags in the local `FLAGS` array that no longer appear in upstream `arg.h`/`arg.cpp`.

Report for each:
- Flag name and shorthand
- Whether it was renamed, merged, or removed
- Whether it should be deleted from `flags.js` or mapped to a new flag

#### C. Changed flags

Flags that exist in both but have diverged. Report for each:

| Property | What to check |
|---|---|
| Shorthand | Has `-x` changed? |
| Type | Has `int` become `float`, etc.? |
| Default | Has the default value changed? |
| Enum options | Have options been added/removed/renamed? |
| Description | Significant description changes |
| Deprecation | Has the flag been marked deprecated upstream? |

#### D. Chat template changes

Compare `BUILTIN_CHAT_TEMPLATES` against the built-in templates listed in upstream source (usually in `src/chat.cpp` or `common/chat.cpp`).

Report:
- New built-in templates not in `BUILTIN_CHAT_TEMPLATES`
- Templates in `BUILTIN_CHAT_TEMPLATES` that no longer exist upstream
- Any template name changes

#### E. New server-only features

Flags present in `examples/server/README.md` or `tools/server/server.cpp` that do not appear in `arg.h` (these are sometimes defined separately). Report these with the same details as group A.

---

## Output Format

Present findings as a structured markdown report with these sections:

```
## Flag Audit Report — [date]

**Upstream ref:** master branch (or specific commit if pinned)
**Local FLAGS count:** [N]
**Upstream flag count:** [M]

### A. New Upstream Flags ([count])
| Flag | Short | Type | Default | Tool | Suggested Category |
|---|---|---|---|---|---|
| --new-flag | -x | int | 42 | both | sampling |

[Description and notes]

### B. Removed/Renamed Upstream Flags ([count])
| Local Flag | Local Short | Status | Action |
|---|---|---|---|
| --old-flag | -o | Removed | Delete from FLAGS |

[Details]

### C. Changed Flags ([count])
| Local Flag | Property | Local Value | Upstream Value |
|---|---|---|---|
| --temp | default | 0.8 | 0.7 |

[Details]

### D. Chat Template Changes ([count])
[List added/removed/renamed templates]

### E. Other Server Features ([count])
[Any server-only flags found outside arg.h]

### Summary
- [N] new flags to consider adding
- [M] flags to remove or remap
- [K] flags with changed properties
- [T] template changes
```

If no changes are found in a category, report it as:

> No changes found.

---

## Flag Matching Rules

When comparing local to upstream, match flags by their CLI name (the `flag` field). Use these rules:

1. **Exact match**: `--ctx-size` matches `--ctx-size`
2. **Shorthand match**: `-c` matches if the upstream shorthand is `-c`
3. **Negation flags**: `--no-mmap` maps to `--mmap` (bool with `false_flag`)
4. **Long-form variants**: If upstream uses `--ctx-size` and local uses `-c`, match via the shorthand cross-reference in `arg.h`

If a flag cannot be matched by name or shorthand, list it as unmatched in the relevant section.

---

## Category Mapping Guide

When suggesting a `FLAG_CATEGORIES` assignment for new flags, use these heuristics:

| Category | Keywords |
|---|---|
| `model` | model loading, HF repo, mmproj, vocab, merge |
| `context` | context size, batch, memory, cache-RAM, mmap, mlock, SWA |
| `cpu` | threads, NUMA, CPU affinity, priority, polling |
| `gpu` | GPU layers, device, flash attention, offload, split, tensor, fit |
| `sampling` | temperature, top-k, top-p, min-p, penalties, samplers, DRY, XTC, mirostat, seed |
| `rope` | RoPE, YaRN, frequency, scaling |
| `conversation` | chat, template, prompt, system, conversation, reasoning |
| `lora` | LoRA, control vector, adapter |
| `kv` | KV cache type, cache quantization, context shift |
| `speculative` | speculative, draft, spec |
| `server` | host, port, API key, parallel, batching, timeout, metrics, WebUI, MCP, tools, embedding |
| `grammar` | grammar, JSON schema, constraints, sampling backend |
| `logging` | verbose, log, timestamps, colors, timings |
| `advanced` | override, tensor check, warmup, offline, host buffer |

---

## Chat Template Source

Upstream built-in chat templates are defined in:
- `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/src/chat.cpp` — look for the `llama_chat_builtin_templates` array or similar registry
- `https://raw.githubusercontent.com/ggerganov/llama.cpp/master/common/chat.cpp` — alternate location

Extract the full list of template name strings and compare against `BUILTIN_CHAT_TEMPLATES` in `flags.js`.

---

## Reminders

- Do not modify any files during the audit unless the user explicitly asks.
- If the upstream sources cannot be fetched, report the failure and suggest the user check manually.
- Always note the upstream branch/commit the comparison was made against.
- The `BUILTIN_CHAT_TEMPLATES` list is used for backward compatibility only — new built-in templates do not need to be added to `CHAT_TEMPLATE_PRESETS` unless they map to a Kobold-style preset. But they should be reported so the developer can decide.
