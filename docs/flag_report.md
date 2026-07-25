# Flag Audit Report - May 9, 2026

> Archived historical audit. The current compatibility report is `docs/design-docs/llama_cpp_compat_report.md`.

**Upstream ref:** `ggml-org/llama.cpp` master at `1e5ad35d560b90a8ac447d149c8f8447ae1fcaa0`  
**Local FLAGS count at time of audit:** 134  
**Upstream server/common flag count parsed:** 234 server-relevant flags from `common/arg.cpp`

> **Superseded — reviewed July 25, 2026.** Several findings below have since been implemented or were wrong when written. Corrections, verified against the current tree and upstream `master`:
>
> - **Section A, now exposed locally:** `--jinja` (`ui/js/flags/definitions.js:1155`), `--reasoning-format` (`:1104`), `--kv-unified` / `--no-kv-unified` (`:1264`).
> - **Section C, now resolved:** `-sm` includes `tensor` (`:403`); `--tools` includes `get_datetime` (`:1581`); `--mmap` defaults to `true` (`:203`), matching upstream — no longer a divergence. Only the `--ctx-size`, `-fitc`, and `--metrics` default divergences still stand.
> - **Section D was incorrect** — see the corrected note in that section.
> - Local flag count has since grown from 134 to roughly 167 entries.
> - This audit parsed 234 "server-relevant" flags; the June 2026 compatibility report parsed 331 across a wider surface. The 110-unmatched figure is therefore **not** comparable across the two reports.

## A. New Upstream Flags

Found **110 upstream server/common flags not exposed in the split flag definitions under `ui/js/flags/`**. Most are advanced or router/speculative/server-management options rather than obvious required GUI basics.

Highest-signal additions to consider:

| Flag | Short | Tool | Suggested Category |
|---|---:|---|---|
| `--split-mode` (`tensor` option) | `-sm` | both | gpu |
| `--tools` (`get_datetime` option) | | server | server |
| `--reasoning-format` | | server | conversation |
| `--reasoning-budget-message` | | server | conversation |
| `--jinja` | | server | conversation |
| `--api-key-file` | | server | server |
| `--ssl-key-file`, `--ssl-cert-file` | | server | server |
| `--rerank` / `--reranking` | | server | server |
| `--slots`, `--slot-save-path` | | server | server |
| `--mmproj-url` | `-mmu` | both | model |
| `--model-url` | `-mu` | both | model |
| `--hf-repo-v`, `--hf-file-v` | `-hfv`, `-hffv` | both | model |
| `--kv-unified` | `-kvu` | server | kv |
| `--cache-idle-slots` | | server | kv/server |
| `--spec-draft-device` | `-devd` | server | speculative/gpu |
| `--spec-draft-type-k`, `--spec-draft-type-v` | `-ctkd`, `-ctvd` | both | speculative/kv |

Other grouped additions include CPU batch affinity flags, lookup-cache flags, advanced speculative n-gram tuning flags, router model flags, SSL/webui config flags, and default-model shortcut flags.

Grouped unmatched upstream flags:

| Group | Count | Examples |
|---|---:|---|
| context/kv | 9 | `--cache-list`, `--lookup-cache-static`, `--lookup-cache-dynamic`, `--kv-unified`, `--cache-idle-slots`, `--prompt-cache-ro`, `--defrag-thold`, `--sequences` |
| cpu | 20 | `--cpu-strict`, `--cpu-mask-batch`, `--prio-batch`, `--poll-batch`, draft CPU/thread affinity flags |
| sampling/speculative | 30 | `--sampler-seq`, `--dry-penalty-last-n`, `--adaptive-target`, `--adaptive-decay`, `--logit-bias`, advanced `--spec-*` n-gram flags |
| advanced/default shortcuts | 14 | `--pooling`, `--tags`, `--embd-gemma-default`, `--gpt-oss-20b-default`, `--vision-gemma-4b-default` |
| model | 15 | `--mmproj-url`, `--image-min-tokens`, `--image-max-tokens`, `--model-url`, `--docker-repo`, `--hf-repo-v`, `--hf-file-v` |
| gpu | 5 | `--rpc`, `--list-devices`, `--op-offload`, `--spec-draft-p-split`, `--spec-draft-device` |
| server | 10 | `--reuse-port`, `--path`, `--api-prefix`, `--webui-config`, `--rerank`, `--props`, `--slots`, `--slot-save-path` |
| conversation | 5 | `--jinja`, `--reasoning-format`, `--reasoning-budget-message`, `--skip-chat-parsing`, `--prefill-assistant` |
| lora | 1 | `--lora-init-without-apply` |
| logging | 1 | `--log-disable` |

## B. Removed/Renamed Upstream Flags

No local flag appears truly removed.

| Local Flag | Upstream Status | Action |
|---|---|---|
| `--no-mmproj` | Still accepted, but now appears as the negation alias for canonical `--mmproj-auto` / `--no-mmproj-auto` | Optional cleanup: model this as `--mmproj-auto` with `false_flag`, but current launch args remain valid |

## C. Changed Flags

| Local Flag | Property | Local Value | Upstream Value |
|---|---|---|---|
| `-sm` / `--split-mode` | enum options | `none`, `layer`, `row` | adds `tensor` |
| `--tools` | enum options | missing `get_datetime` | upstream includes `get_datetime` |
| `-c` / `--ctx-size` | default | `64000` | upstream default `0`, loaded from model |
| `--mmap` | default | local default disables mmap via `--no-mmap` | upstream default enabled |
| `-fitc` / `--fit-ctx` | default | `64000` | upstream default `4096` |
| `-np` / `--parallel` | default | `-1` | upstream default `1` (correction, July 2026: upstream now defaults to `-1` = auto as well — no longer a divergence) |
| `--metrics` | default | local default enabled | upstream default disabled |

The default differences may be intentional GUI safe defaults, but because this app emits defaults into launch args, they do change `llama-server` behavior versus upstream.

## D. Chat Template Changes

> **Corrected July 25, 2026.** This section was wrong. `hunyuan-ocr` is not and never was an upstream template name — it does not appear in `src/llama-chat.cpp` (the likely source of the confusion is `deepseek-ocr`, which local already carried). `granite-4.0` is present locally (`ui/js/flags/chat-templates.js:21`), as is `granite-4.1`, which the original audit did not mention.
>
> As of the July 2026 re-check, upstream exposes 54 built-in template names and local `BUILTIN_CHAT_TEMPLATES` contains the same 54 — the two sets are identical, with nothing missing in either direction.

Original (incorrect) finding, retained for the record:

- Upstream built-in chat templates: 53; local `BUILTIN_CHAT_TEMPLATES`: 51
- Claimed missing locally: `granite-4.0`, `hunyuan-ocr`
- No local built-in template names appear removed upstream.

## E. Other Server Features

No server-only CLI flags were found in `tools/server/server.cpp` or `tools/server/README.md` outside the `common/arg.cpp` parser.

## Summary

- 110 upstream flags are not exposed locally.
- 0 local flags appear removed upstream.
- 7 notable changed/default/enum findings (as of July 2026: 3 still stand — `--ctx-size`, `-fitc`, `--metrics`).
- 2 new built-in chat templates should be added to the compatibility list if desired (as of July 2026: 0 — this finding was incorrect, see section D).
- No files were changed during the audit pass that produced this report.

Sources used:

- `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/common/arg.cpp`
- `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/common/arg.h`
- `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md`
- `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server.cpp`
- `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/src/llama-chat.cpp`
