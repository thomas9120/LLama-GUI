# Agent Workflows

Consolidated reference for routine maintenance tasks: auditing the split `ui/js/flags/` modules against upstream `llama.cpp` and updating bundled chat templates.

## Flag Audit Workflow

Audit the loaded `ui/js/flags/` modules against upstream `llama.cpp` and produce a structured markdown report of findings.

Do not modify the flag modules during the audit unless the user explicitly asks for implementation.

### Files To Check

**Local**

| File | Role |
|---|---|
| `ui/js/flags/definitions.js` | Single source of truth for all CLI flags exposed in the UI |
| `ui/js/flags/categories.js` / `options.js` / `chat-templates.js` / `helpers.js` | Supporting categories, shared option lists, chat template presets, and flag helpers |
| `ui/js/flag-core.js` | Shared flag state, setters, selected model/tool state, command preview, and launch-arg generation that consumes `FLAGS` |
| `ui/js/config-flags-ui.js` | Configure tab rendering for all flag input types, search/filtering, input restore, and high-risk multi-select warnings |
| `ui/js/flag-validation.js` | Startup validation for flag definition shape, duplicate ids, duplicate CLI flags, enum options, and defaults |
| `ui/js/app.js` | App orchestration/bootstrap, launch/stop wiring, shared polling, toasts, and cross-module initialization |
| `ui/js/quick-launch-ui.js` | Quick Launch controls, profiles, summaries, and mirrored sampler/template UI |
| `ui/js/chat-ui.js` / `chat-rendering.js` | Chat tab state, streaming UI, conversation history, markdown/source rendering |
| `ui/js/api-tab.js` / `remote-tunnel-ui.js` | API endpoint helpers and Cloudflare tunnel controls |
| `ui/js/hf-download-ui.js` | Hugging Face model downloader UI in Quick Launch |
| `ui/js/sampler-presets.js` | Shared sampler preset store and apply/save/delete behavior |

**Upstream**

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

### Efficient Workflow

#### 1. Pin upstream

Fetch the upstream master commit first and include the SHA in the report. This makes the audit reproducible even if master changes later.

#### 2. Parse local `FLAGS`

Use a JavaScript runtime instead of regex-only parsing so shared constants like `CHAT_TEMPLATE_PRESET_OPTIONS` resolve correctly. Load the ordered flag modules exactly as `ui/index.html` does.

Example shape:

```js
const fs = require("fs");
const vm = require("vm");

const flagFiles = [
  "ui/js/flags/categories.js",
  "ui/js/flags/options.js",
  "ui/js/flags/chat-templates.js",
  "ui/js/flags/definitions.js",
  "ui/js/flags/helpers.js",
];
const src = flagFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n")
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

#### 3. Parse upstream flags

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

#### 4. Match flags

Match by all known aliases, not just the local `flag` field.

Rules:

1. Exact long-form match: `--ctx-size` matches `--ctx-size`.
2. Shorthand match: local `-c` matches upstream `{"-c", "--ctx-size"}`.
3. Negation match: local `false_flag: "--no-mmap"` matches upstream `{"--mmap"}, {"--no-mmap"}`.
4. Canonical-renamed bools: if local uses a negation alias that upstream still accepts, report it as a rename/cleanup, not a removal.
5. Option additions count as changed flags, not new flags. Example: upstream adding `tensor` to `--split-mode`.

#### 5. Compare and categorize

##### A. New upstream flags not in `definitions.js`

Report upstream server/common flags that have no local alias match.

For each high-signal flag include:

- flag and shorthand
- rough type
- upstream default, when easily available
- description
- tool scope
- suggested `FLAG_CATEGORIES` category

For large unmatched sets, summarize by category and list the highest-value candidates rather than dumping every niche flag into a huge table.

##### B. Local flags missing from upstream

Report local flags that have no upstream alias match.

Before calling a flag removed, check whether it is still accepted as:

- a negation alias
- a secondary alias
- a renamed canonical flag
- a server-only option

##### C. Changed flags

Check:

| Property | What to compare |
|---|---|
| Shorthand | Added, removed, or changed aliases |
| Type | int, float, bool, string, enum, multi-value |
| Default | Upstream default vs local default |
| Enum options | Added, removed, renamed options |
| Description | Significant behavior changes |
| Deprecation | Warnings or deprecation notes in handler/help text |

Important: local defaults may intentionally differ as GUI safe defaults. Still report them, because this app initializes `flagCore` state from `getDefaultValues()` and launch args may emit those values.

##### D. Chat template changes

Compare local `BUILTIN_CHAT_TEMPLATES` against upstream `LLM_CHAT_TEMPLATES` in `src/llama-chat.cpp`.

Report:

- new upstream built-ins missing locally
- local built-ins no longer upstream
- likely renamed templates

Remember: `BUILTIN_CHAT_TEMPLATES` is a compatibility allowlist. New upstream templates do not automatically need curated dropdown presets unless they map to a user-facing preset.

##### E. Other server features

Scan `tools/server/server.cpp` and `examples/server/README.md` for `--flag` strings not found in `common/arg.cpp`. If none are found, state that.

### Category Mapping Guide

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

### Output Format

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

### Current Known Patterns

These examples came up in a recent audit and are useful as calibration points:

- `--no-mmproj` is still accepted upstream, but the canonical positive flag is now `--mmproj-auto` with negations `--no-mmproj` / `--no-mmproj-auto`.
- `--split-mode` currently accepts `none`, `layer`, `row`, and `tensor`; local UI may lag by missing `tensor`.
- `--tools` currently includes `get_datetime`; local UI may lag by missing it.
- `src/llama-chat.cpp` currently contains the built-in template map, not `src/chat.cpp`.
- `common/arg.cpp` can contain more than 100 upstream server/common flags that the GUI does not expose. Treat this as a curated-surface decision unless a flag is user-facing, newly important, or affects an already exposed control.

### Reminders

- Prefer `rg` for local search.
- On Windows/PowerShell, prefer safe `rg` patterns such as `rg -n "pattern" ui/js` or `rg -n -g "*.js" "pattern" ui/js`; avoid path globs like `ui/js/*.js`.
- Keep the audit read-only unless the user asks for edits.
- Always include the upstream commit SHA.
- Report default differences even if they are intentional.
- Do not add every upstream flag automatically. Prioritize flags that affect existing controls, user-visible launch behavior, compatibility, security, or common server workflows.

---

## Chat Template Update Workflow

Use this workflow when updating bundled chat templates under `ui/templates/`, especially model-family presets exposed through `ui/js/flags/chat-templates.js`.

### Source Of Truth

- Prefer official model repos for model-specific templates. For Hugging Face repos, check whether `chat_template.jinja` exists at the repo root before relying on `tokenizer_config.json`.
- Check related model sizes separately. A family may not share one template across all variants.
- For llama.cpp compatibility, also check the current upstream llama.cpp docs, template examples, and relevant issues/discussions if the template uses newer syntax or model-specific parsing.
- Do not use small assistant/helper repos as the source for main instruct templates unless they actually expose the intended template.

### Update Steps

1. Find all current app references:
   - Template files: `ui/templates/*`
   - Preset definitions: `CHAT_TEMPLATE_PRESETS` in `ui/js/flags/chat-templates.js`
   - Shared state and launch helpers in `ui/js/flag-core.js` if new launch-state behavior is needed
   - Configure rendering behavior in `ui/js/config-flags-ui.js` if a new flag input type or rendering rule is needed
   - Quick Launch dropdown/summary helpers in `ui/js/quick-launch-ui.js` if new template UI behavior is needed there
   - Chat sidebar template/sampler behavior in `ui/js/chat-ui.js` if chat-specific UI behavior is needed
2. Download the official template files and compare variants by size/hash/content.
3. Add or replace bundled `.jinja` files with the upstream content.
4. Keep backward-compatible template paths when saved presets may already reference them.
5. Update `CHAT_TEMPLATE_PRESETS`; Quick Launch clones options from the `chat_template` flag, so do not maintain a second list.
6. Bundled presets should set `chat_template_custom` and clear `chat_template`; built-in presets should do the opposite.

### NoThink Templates

- Prefer deriving NoThink templates from the exact official upstream template for that model family, not from a generic wrapper.
- Force no-think inside the bundled template, for example:

```jinja
{%- set enable_thinking = false -%}
```

- Preserve model-family-specific disabled-thinking behavior. Example from Gemma 4:
  - E2B/E4B disabled thinking ends generation with a plain model turn.
  - 26B-A4B/31B disabled thinking keeps the empty thought block:

```text
<|channel>thought\n<channel|>
```

- Verify NoThink templates never render `<|think|>`, even if runtime kwargs pass `enable_thinking=true`.
- Keep upstream logic that strips historical assistant thinking from prior messages unless there is a clear reason to change it.

### Validation Checklist

- Confirm every new preset appears in both Configure and Quick Launch.
- Confirm mirrored controls stay synced when either one changes.
- Confirm command preview uses `--chat-template-file` for bundled templates and does not also emit `--chat-template`.
- Run `tests/frontend/flag_sync_smoke.cjs` after flag or mirrored-control changes when Playwright is available.
- Render representative samples through each template:
  - plain user/assistant turns
  - system/developer prompts
  - multimodal content markers
  - tool definitions
  - tool calls
  - tool responses
  - `add_generation_prompt`
- For NoThink variants, assert no `<|think|>` appears in rendered output.
- For thinking-capable variants, assert `enable_thinking=true` still emits the expected thinking trigger.
- Run a browser smoke test against `ui/index.html` served from the `ui/` directory, because the page uses root-relative assets like `/js/app.js`.

### Useful One-Off Checks

Fetch and hash official Hugging Face templates:

```powershell
$repos = @(
  "google/gemma-4-E2B-it",
  "google/gemma-4-E4B-it",
  "google/gemma-4-26B-A4B-it",
  "google/gemma-4-31B-it"
)
foreach ($repo in $repos) {
  $url = "https://huggingface.co/$repo/raw/main/chat_template.jinja"
  $content = (Invoke-WebRequest -UseBasicParsing -Uri $url).Content
  $sha = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes($content)
    )
  ).Replace("-", "").ToLower()
  "$repo $($content.Length) $sha"
}
```

Check bundled Gemma templates for thinking markers:

```powershell
Get-ChildItem ui/templates -Filter *gemma* | ForEach-Object {
  $text = Get-Content -Raw -Path $_.FullName
  $think = [regex]::Matches($text, [regex]::Escape("<|think|>")).Count
  $empty = [regex]::Matches($text, [regex]::Escape("<|channel>thought\n<channel|>")).Count
  $force = [regex]::Matches($text, "set\s+enable_thinking\s*=\s*false").Count
  "$($_.Name): think=$think empty_thought=$empty force_no_think=$force"
}
```

### Notes From Gemma 4 Update

- Official Hugging Face Gemma 4 templates were in root-level `chat_template.jinja`, not `tokenizer_config.json`.
- `google/gemma-4-E2B-it` and `google/gemma-4-E4B-it` shared one template.
- `google/gemma-4-26B-A4B-it` and `google/gemma-4-31B-it` shared another template.
- `*-assistant` repos did not provide the main instruct template and were not used.
- Static file smoke tests should serve `ui/` as the web root:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Run that command from the `ui/` directory, then open `http://127.0.0.1:8765/index.html`.
