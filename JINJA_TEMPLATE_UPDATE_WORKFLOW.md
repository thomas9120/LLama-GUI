# Jinja Template Update Workflow

Use this workflow when updating bundled chat templates under `ui/templates/`, especially model-family presets exposed through `ui/js/flags.js`.

## Source Of Truth

- Prefer official model repos for model-specific templates. For Hugging Face repos, check whether `chat_template.jinja` exists at the repo root before relying on `tokenizer_config.json`.
- Check related model sizes separately. A family may not share one template across all variants.
- For llama.cpp compatibility, also check the current upstream llama.cpp docs, template examples, and relevant issues/discussions if the template uses newer syntax or model-specific parsing.
- Do not use small assistant/helper repos as the source for main instruct templates unless they actually expose the intended template.

## Update Steps

1. Find all current app references:
   - Template files: `ui/templates/*`
   - Preset definitions: `CHAT_TEMPLATE_PRESETS` in `ui/js/flags.js`
   - Shared state helpers in `ui/js/app.js` if new behavior is needed
2. Download the official template files and compare variants by size/hash/content.
3. Add or replace bundled `.jinja` files with the upstream content.
4. Keep backward-compatible template paths when saved presets may already reference them.
5. Update `CHAT_TEMPLATE_PRESETS`; Quick Launch clones options from the `chat_template` flag, so do not maintain a second list.
6. Bundled presets should set `chat_template_custom` and clear `chat_template`; built-in presets should do the opposite.

## NoThink Templates

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

## Validation Checklist

- Confirm every new preset appears in both Configure and Quick Launch.
- Confirm mirrored controls stay synced when either one changes.
- Confirm command preview uses `--chat-template-file` for bundled templates and does not also emit `--chat-template`.
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

## Useful One-Off Checks

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

## Notes From Gemma 4 Update

- Official Hugging Face Gemma 4 templates were in root-level `chat_template.jinja`, not `tokenizer_config.json`.
- `google/gemma-4-E2B-it` and `google/gemma-4-E4B-it` shared one template.
- `google/gemma-4-26B-A4B-it` and `google/gemma-4-31B-it` shared another template.
- `*-assistant` repos did not provide the main instruct template and were not used.
- Static file smoke tests should serve `ui/` as the web root:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Run that command from the `ui/` directory, then open `http://127.0.0.1:8765/index.html`.
