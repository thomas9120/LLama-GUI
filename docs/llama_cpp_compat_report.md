# Llama.cpp Compatibility Report - 2026-05-29

**Upstream ref:** `ggml-org/llama.cpp` master at `2084434e666c5b08cd5e2a2f256e583a0f85a44c`
**Latest release checked:** `b9413`
**Local FLAGS count:** 138
**Upstream flag count parsed:** 328

## A. Potential Launch Breakages

No changes found.


## B. New Upstream Flags Not Exposed

Showing up to 60 high-signal unmatched upstream flags. Treat this as a curated-surface review list, not an automatic add list.

| Canonical | Aliases | Type | Suggested category | Upstream help |
| --- | --- | --- | --- | --- |
| --cache-list | -cl, --cache-list | unknown | model | -cl --cache-list show list of models in cache |
| --display-prompt | --display-prompt | bool | conversation | --display-prompt --no-display-prompt whether to print prompt at generation (default: %s) |
| --color | -co, --color | text | advanced | -co --color [on\|off\|auto] |
| --cpu-strict | --cpu-strict | text | cpu | --cpu-strict use strict CPU placement (default: %u)\n |
| --cpu-mask-batch | -Cb, --cpu-mask-batch | text | context | -Cb --cpu-mask-batch CPU affinity mask: arbitrarily long hex. Complements cpu-range-batch (default: same as --cpu-mask) |
| --cpu-range-batch | -Crb, --cpu-range-batch | text | context | -Crb --cpu-range-batch lo-hi |
| --cpu-strict-batch | --cpu-strict-batch | text | context | --cpu-strict-batch use strict CPU placement (default: same as --cpu-strict) |
| --prio-batch | --prio-batch | unknown | context | --prio-batch set process/thread priority : 0-normal, 1-medium, 2-high, 3-realtime (default: %d)\n invalid value |
| --poll-batch | --poll-batch | text | context | --poll-batch use polling to wait for work (default: same as --poll) |
| --lookup-cache-static | -lcs, --lookup-cache-static | text | kv | -lcs --lookup-cache-static path to static lookup cache to use for lookup decoding (not updated by generation) |
| --lookup-cache-dynamic | -lcd, --lookup-cache-dynamic | text | kv | -lcd --lookup-cache-dynamic path to dynamic lookup cache to use for lookup decoding (updated by generation) |
| --kv-unified | -kvu, --kv-unified | unknown | kv | -kvu --kv-unified -no-kvu |
| --cache-idle-slots | --cache-idle-slots | unknown | kv | --cache-idle-slots --no-cache-idle-slots save and clear idle slots on new task (default: enabled, requires unified KV an |
| --chunks | --chunks | unknown | advanced | --chunks max number of chunks to process (default: %d, -1 = all) |
| --perf | --perf | bool | logging | --perf --no-perf whether to enable internal libllama performance timings (default: %s) |
| --in-file | --in-file | text | speculative | --in-file an input file (use comma-separated values to specify multiple files) error: failed to open file '%s'\n |
| --binary-file | -bf, --binary-file | text | conversation | -bf --binary-file binary file containing the prompt (default: none) |
| --escape | -e, --escape | bool | advanced | -e --escape --no-escape |
| --print-token-count | -ptc, --print-token-count | unknown | advanced | -ptc --print-token-count print token count every N tokens (default: %d) |
| --prompt-cache | --prompt-cache | text | conversation | --prompt-cache file to cache prompt state for faster startup (default: none) |
| --prompt-cache-all | --prompt-cache-all | bool | conversation | --prompt-cache-all if specified, saves user input and generations to cache as well\n |
| --prompt-cache-ro | --prompt-cache-ro | bool | conversation | --prompt-cache-ro if specified, uses the prompt cache but does not update it |
| --special | -sp, --special | bool | speculative | -sp --special special tokens output enabled (default: %s) |
| --interactive | -i, --interactive | bool | advanced | -i --interactive run in interactive mode (default: %s) |
| --interactive-first | -if, --interactive-first | bool | advanced | -if --interactive-first run in interactive mode and wait for input right away (default: %s) |
| --in-prefix-bos | --in-prefix-bos | bool | advanced | --in-prefix-bos prefix BOS to user inputs, preceding the `--in-prefix` string |
| --in-prefix | --in-prefix | text | advanced | --in-prefix string to prefix user inputs with (default: empty) |
| --in-suffix | --in-suffix | text | advanced | --in-suffix string to suffix after user inputs with (default: empty) |
| --spm-infill | --spm-infill | bool | model | --spm-infill use Suffix/Prefix/Middle pattern for infill (instead of Prefix/Suffix/Middle) as some models prefer this. ( |
| --sampler-seq | --sampler-seq, --sampling-seq | text | sampling | --sampler-seq --sampling-seq simplified sequence for samplers that will be used (default: %s) |
| --dry-penalty-last-n | --dry-penalty-last-n | unknown | context | --dry-penalty-last-n set DRY penalty for the last n tokens (default: %d, 0 = disable, -1 = context size) error: invalid  |
| --dry-sequence-breaker | --dry-sequence-breaker | text | sampling | --dry-sequence-breaker add sequence breaker for DRY sampling, clearing out default breakers (%s) in the process; use \   |
| --adaptive-target | --adaptive-target | float | advanced | --adaptive-target adaptive-p: select tokens near this probability (valid range 0.0  to 1.0; negative = disabled) (defaul |
| --adaptive-decay | --adaptive-decay | float | advanced | --adaptive-decay adaptive-p: decay rate for target adaptation over time. lower values  are more reactive, higher values  |
| --logit-bias | -l, --logit-bias | float | logging | -l --logit-bias TOKEN_ID(+/-)BIAS |
| --pooling | --pooling | text | model | --pooling {none,mean,cls,last,rank} pooling type for embeddings, use model default if unspecified |
| --attention | --attention | text | model | --attention {causal,non-causal} attention type for embeddings, use model default if unspecified |
| --grp-attn-n | -gan, --grp-attn-n | unknown | advanced | -gan --grp-attn-n group-attention factor (default: %d) |
| --grp-attn-w | -gaw, --grp-attn-w | unknown | advanced | -gaw --grp-attn-w group-attention width (default: %d) |
| --hellaswag | --hellaswag | bool | context | --hellaswag compute HellaSwag score over random tasks from datafile supplied with -f |
| --hellaswag-tasks | --hellaswag-tasks | unknown | context | --hellaswag-tasks number of tasks to use when computing the HellaSwag score (default: %zu) |
| --winogrande | --winogrande | bool | advanced | --winogrande compute Winogrande score over random tasks from datafile supplied with -f |
| --winogrande-tasks | --winogrande-tasks | unknown | advanced | --winogrande-tasks number of tasks to use when computing the Winogrande score (default: %zu) |
| --multiple-choice | --multiple-choice | bool | advanced | --multiple-choice compute multiple choice score over random tasks from datafile supplied with -f |
| --multiple-choice-tasks | --multiple-choice-tasks | unknown | advanced | --multiple-choice-tasks number of tasks to use when computing the multiple choice score (default: %zu) |
| --kl-divergence | --kl-divergence | bool | logging | --kl-divergence computes KL-divergence to logits provided via --kl-divergence-base |
| --save-all-logits | --save-all-logits, --kl-divergence-base | text | logging | --save-all-logits --kl-divergence-base set logits file |
| --ppl-stride | --ppl-stride | unknown | advanced | --ppl-stride stride for perplexity calculation (default: %d) |
| --ppl-output-type | --ppl-output-type | text | advanced | --ppl-output-type output type for perplexity calculation (default: %d) |
| --defrag-thold | -dt, --defrag-thold | text | kv | -dt --defrag-thold KV cache defragmentation threshold (DEPRECATED) |
| --sequences | -ns, --sequences | unknown | advanced | -ns --sequences number of sequences to decode (default: %d) |
| --mmproj-url | -mmu, --mmproj-url | text | model | -mmu --mmproj-url URL to a multimodal projector file. see tools/mtmd/README.md |
| --image | --image, --audio | text | model | --image --audio path to an image or audio file. use with multimodal models, use comma-separated values for multiple file |
| --image-min-tokens | --image-min-tokens | unknown | model | --image-min-tokens minimum number of tokens each image can take, only used by vision models with dynamic resolution (def |
| --image-max-tokens | --image-max-tokens | unknown | model | --image-max-tokens maximum number of tokens each image can take, only used by vision models with dynamic resolution (def |
| --rpc | --rpc | text | server | --rpc comma-separated list of RPC servers (host:port) |
| --list-devices | --list-devices | unknown | gpu | --list-devices print list of available devices and exit Available devices:\n |
| --fit-print | -fitp, --fit-print | text | gpu | -fitp --fit-print print the estimated required memory ('on' or 'off', default: '%s') |
| --op-offload | --op-offload | bool | gpu | --op-offload --no-op-offload whether to offload host tensor operations to device (default: %s) |
| --tags | --tags | text | model | --tags set model tags, comma-separated (informational, not used for routing) |


## C. Changed Existing Flags

| Local id | Flag | Change | Local/GUI | Upstream |
| --- | --- | --- | --- | --- |
| split_mode | -sm | enum options | missing: tensor | stale:  |
| preserve_thinking | --chat-template-kwargs | type | bool | text |


## D. Chat Template Changes

| Change | Templates |
| --- | --- |
| Upstream templates missing locally | granite-4.0, granite-4.1, hunyuan-vl |
| Local built-ins absent upstream | None |


## E. Binary Download Compatibility

| Backend label | Expected release asset | Kind |
| --- | --- | --- |
| SYCL (Intel) | llama-b9413-bin-win-sycl-x64.zip | primary |
| Metal + KleidiAI (Apple Silicon) | llama-b9413-bin-macos-arm64-kleidiai.tar.gz | primary |


Additional upstream llama release assets not mapped locally:

llama-b9413-bin-android-arm64.tar.gz, llama-b9413-ui.tar.gz, llama-b9413-xcframework.zip

## F. Notes and Next Steps

- Verify high-severity findings manually against upstream source before editing.
- Local defaults can intentionally differ from upstream safe defaults; report them when they affect emitted launch args.
- Do not add every unmatched upstream flag automatically; prioritize install and launch compatibility.
