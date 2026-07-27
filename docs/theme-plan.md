# Theme System Expansion Plan

**Status:** Complete — all five steps shipped
**Created:** 2026-07-27
**Scope:** Entire GUI, not just Quick Launch.
**Mockup:** [`quick-launch-theme-mockup.html`](quick-launch-theme-mockup.html)

## Goal

Grow the theme system from two themes (Tokyo, Cappuccino) to four (adding
Graphite and Mint), and — more importantly — make the *fifth* theme cheap.

The target contract is:

> A theme is **one `[data-theme="x"]` token block plus one registry entry**.
> No theme-specific selectors anywhere else in the codebase.

Today the contract is "a token block *plus* scattered per-theme override
blocks in `style.css` *plus* hardcoded theme names in three JS locations."
That is what makes each new theme expensive, and it is the bulk of the work
below.

## Background: what exists now

| Piece | Location | Notes |
| --- | --- | --- |
| Token palettes | `ui/css/tokens.css` | Tokyo in bare `:root`; Cappuccino in `:root[data-theme="cappuccino"]` |
| Theme switcher markup | `ui/index.html:140-149` | Two side-by-side buttons in the sidebar footer |
| Pre-paint theme application | `ui/index.html:12-22` | Inline blocking script; hardcodes `"cappuccino"` |
| Theme state/persistence | `ui/js/theme-ui.js` | `SUPPORTED_THEMES` set, `localStorage`, `aria-pressed` switcher state |
| Unit test | `tests/frontend/theme_ui_unit.cjs` | Assumes exactly two themes, asserts `aria-pressed` |

## Proposed themes

**Graphite** — a neutral mid-tone between Tokyo (dark) and Cappuccino
(light). Medium-gray surfaces, warm off-white text, copper accent.

**Mint** — Linux Mint inspired. Pale seafoam surfaces, green-tinged
accents.

---

## 1. Palette corrections

Contrast ratios below are foreground against `--bg-surface`. WCAG AA for
normal text is 4.5:1; 3:1 is the threshold for large text and UI components.

### 1a. Mint's accent collapses into body text — blocking

Mint proposes `--accent: #1a2420` (near-black) while `--fg: #1e2b24`. The
contrast ratio *between them* is **1.08** — they are the same color to the
eye.

`--accent` is not only a button fill. It is used as **text** in ~30 places
in `style.css` (`.card-kicker`, `.sampler-slider-value`,
`.nav-item.active .icon`, `.badge-accent`, `.preset-chip.active`,
`.status-box.info`, `.server-link`, `.toast-info .toast-icon`,
`blockquote` borders, focus rings, …). In Mint, every one of those
"this is active / selected / informational" signals would render as
ordinary body text.

Cappuccino has the same flaw today (`--accent: #4b3832` vs `--fg: #5d3932`
= **1.10** separation), so this is not new — but Mint is the moment to fix
it rather than duplicate it a third time.

**Fix: split the role into two tokens.**

- `--accent` stays the **fill** color (button/chip backgrounds, borders).
  Near-black is genuinely right for Mint's Linux Mint look.
- `--accent-text` is the **text/icon** color. Dark themes set it equal to
  `--accent`; light themes give it a distinguishable hue.

| Theme | `--accent` | `--accent-text` | on surface | vs `--fg` |
| --- | --- | --- | --- | --- |
| Tokyo | `#6c9bff` | `#6c9bff` (same) | 6.53 | 1.75 |
| Graphite | `#d9a05b` | `#d9a05b` (same) | 4.88 | 1.77 |
| Cappuccino | `#4b3832` | `#a8622c` | 4.54 | 2.12 |
| Mint | `#1a2420` | `#2f7d54` | 4.69 | 2.93 |

Caveat worth knowing: Mint's `#2f7d54` measures 3.89 against
`--bg-raised` (`#d4e7dc`). That clears the 3:1 UI-component threshold but
not 4.5:1, so accent text on a *raised* surface in Mint is slightly under
AA for small text. Darkening to `#1f7a4c` gives 4.97 / 4.12 at the cost of
some separation from `--fg`. Either is defensible; the mockup uses
`#2f7d54`.

Alternative considered: make Mint's `--accent` simply be the green and
keep near-black as a Mint-only primary-button override. Rejected — that is
exactly the per-theme override pattern this plan is trying to delete, and
the two-token split fixes Cappuccino for free.

### 1b. Graphite `--red` fails AA

`#e07a68` on `#3a3d43` is **3.71**. Red carries error *text*, not just
borders. Bump to `#ef8a78` → **4.59**.

`--magenta` at `#b698cc` is **4.33** — borderline, and mostly used for
avatars and icons. Bumped to `#c1a6d6` (**5.18**) in the mockup for
consistency; low stakes either way.

### 1c. Graphite's surface ramp is too tight

Proposed: `#33363b` → `#3a3d43` → `#414449` → `#494c52`, roughly 3-4%
luminance per step.

At near-black (Tokyo) those steps read clearly because drop shadows also
land against the dark background. At mid-gray, **both** the steps and the
shadows lose contrast, so cards melt into the page. Widen the ramp:

```
--bg-base:     #2e3136
--bg-surface:  #383b41
--bg-raised:   #43464d
--bg-elevated: #4e5158
--bg-hover:    #585c64
```

All Graphite foregrounds still pass against the new `#383b41` surface
(`--fg` 8.66, `--fg-muted` 4.71, `--accent` 4.88).

### 1d. Graphite's borders vanish at mid-tone

`--border: rgba(255,255,255,0.07)` is a visible hairline on Tokyo's
`#161824`. On a mid-gray it is nearly gone — a white overlay loses contrast
as the base lightens. Graphite needs roughly double: `0.13` / `0.20` for
`--border` / `--border-strong`. (Explicit hex borders would be another
option, but the overlay form keeps the token shape consistent across
themes.)

### 1e. `--yellow` needs a fill variant — the §1a split, inverted

Reported from the Presets tab: the favourite highlight only reads as a
favourite marker in Tokyo.

`.preset-item-favorite` (`style.css:2643`) is a 2px left edge,
`inset 2px 0 0 var(--yellow)`. It is not failing contrast — Cappuccino's
`--yellow` (`#9b733d`) is 4.11:1 against the cream surface. It is failing
*distinguishability*: 1.25:1 against `--fg-muted` and 2.48:1 against the
browser panel's own brown border. In a brown-on-cream theme it reads as one
more brown line. Tokyo's `#f0c75e` is 10.95:1 and unmistakably gold.

This is §1a's problem with the roles reversed. `--yellow` serves two jobs:

- **Warning text** — ~25 sites, mostly `color: var(--yellow)` on
  `--yellow-subtle`. Needs to stay dark enough to read at 10–12px, which is
  why Cappuccino's is a muted brown-gold.
- **Fill** — 4 sites: the favourite bar (`2643`), `.preset-warn-dot`
  (`2575`), and the favourites-only chip's background and border
  (`2470`, `2472`). Needs saturation to read as gold.

The two pull in opposite directions: `#c8892b` reads as gold but drops to
2.86:1 as text on cream. `--accent` needed a *text* variant; `--yellow`
needs a *fill* variant.

**Fix: add `--yellow-solid`**, defaulting to `var(--yellow)` so dark themes
are unaffected, and give light themes a saturated gold. Repoint the four
fill sites. This also fixes the warn dot and the favourites-only chip,
which have the same latent bug. **Done in step 2** — Cappuccino gets
`#b8791f`: 3.49:1 on cream (clearing the 3:1 UI floor) at ~1.6x the
saturation of `--yellow`.

Mint will need it too — its `--yellow` is `#8a6d2f`, the same muted
low-chroma gold, so the marker would be equally lost there.

While doing this, audit `--green`, `--red` and `--cyan` for the same
fill-versus-text tension rather than discovering each one from a bug report.

#### 1e-2. `--favorite` — favourites leave the warm ramp

Follow-on reported after step 4: the preset warning color and the favourite
color were the same. They always had been — `--yellow` was carrying two
unrelated semantics, warning (~49 sites) and favourite (6 sites). The
sharpest case was `.preset-chip-warn.active` and `.preset-chip-favorite.active`,
two adjacent filter chips in the same toolbar with byte-identical
declarations.

Orange was the obvious fix and is the wrong one. Every usable orange sits
only **9–16 degrees of hue** from the warning yellow — under the ~25 that
reads as a different color — and on light themes it crowds `--red` (hue 4).
The warm range is already fully allocated to the severity ramp
(yellow 43 → orange 28 → red 4); a third meaning does not fit.

So the favourite marker leaves the warm range instead. "The user starred
this" is not a severity, so it does not belong on the severity scale at all.

| | `--favorite` | On surface | Hue gap from `--yellow` |
| --- | --- | --- | --- |
| Tokyo | `#b48efa` | 6.88:1 | 142 deg |
| Cappuccino | `#7a4a6b` | 6.69:1 | 76 deg |

Full `--favorite` / `-solid` / `-subtle` / `-border` set, mirroring the other
palette families. Cost, accepted deliberately: favourites are no longer a
gold star. `--yellow` is now warning-only and its ~49 sites were untouched.

### 1e-3. Semantic colors must be sized against their own chip

Reported as "Cappuccino's warning yellow looks too light". It was, but the
audit that followed found the same defect in **ten** places across three
themes — every semantic family except in Tokyo.

The cause is structural, not a bad value. The `-subtle` alphas were chosen
for how the *fill* looked, and then the same hue was reused as text on top
of that fill. Nothing ever checked the pair. So the real worst case for
`--yellow` was never the bare surface (4.11:1, which is what the first
report measured) but its own `--yellow-subtle` chip at **3.45:1**.

Fixed by adjusting lightness only — hue and saturation preserved, so every
color keeps its identity:

| Theme | Token | From | To |
| --- | --- | --- | --- |
| Graphite | `--accent-text` | `var(--accent)` | `#e0b27a` |
| Graphite | `--green` | `#96c47e` | `#a1ca8b` |
| Graphite | `--red` | `#ef8a78` | `#f4aca0` |
| Graphite | `--yellow` | `#d9b45c` | `#e2c072` |
| Graphite | `--favorite` | `#b9a0e0` | `#c9b6e7` |
| Cappuccino | `--accent-text` | `#a8622c` | `#935627` |
| Cappuccino | `--green` | `#66784f` | `#5c6c47` |
| Cappuccino | `--yellow` | `#9b733d` | `#856230` (tint 0.22 → 0.18) |
| Mint | `--accent-text` | `#2f7d54` | `#2a704c` |
| Mint | `--green` | `#35714f` | `#34704e` |
| Mint | `--yellow` | `#8a6d2f` | `#765d26` |

Light themes darken, dark themes brighten — except **Graphite, which
brightens for the opposite reason**: on a mid-tone surface the `-subtle`
chip sits *lighter* than the surface, so light-on-light text loses contrast
exactly where it is most used. Any future mid-tone theme has this inverted
behaviour.

Derived `rgba()` values (`-subtle`, `-border`, `-subtle-hover`,
`--favorite-wash*`, `--yellow-glow`) were updated to track their base color.

**A test now enforces the rule** for every text-bearing family in every
theme, including `--cyan`, against surface, `--bg-raised`, `--bg-elevated`
and the family's own chip. It is mutation-verified:
reverting any of the eleven values above fails it with the offending
theme, token, background and ratio. This is the check that makes adding a
theme safe rather than merely cheap.

### 1f. Neutral text tiers

Originally logged as "`--fg-faint` is sub-3:1 in every theme, but it is
decorative, so no change." That was wrong on the second half. Of its 40
uses, several carry meaning: **placeholder text** in four places, plus
`.badge-dim`, the accordion counts, the theme-menu hints and
`.model-switch-details dt`. WCAG 1.4.3 applies to placeholder text; it is
not exempt.

Two separate problems, so two separate fixes:

1. **Placeholders moved to `--fg-muted`** (`style.css`: `input`,
   `textarea.chat-input`, `textarea.sidebar-system-prompt`,
   `.ss-placeholder`). They are content and must clear AA.
2. **`--fg-faint` raised to the 3:1 floor** in all four themes. It stays
   *below* AA deliberately — pushing it to 4.5 would collapse it into
   `--fg-muted` and the design would lose a tier. 3:1 is the WCAG 1.4.11
   floor for non-text and non-essential text, which is what it is now
   reserved for.

Measuring exposed a third problem: `--fg-muted` itself was below AA on
`--bg-elevated` (Graphite 3.34, Cappuccino 4.02). Text lands on three
backgrounds — surface, `--bg-raised` for panels and rows, `--bg-elevated`
for dropdowns, toasts and `.badge-dim` — and only the first was ever
checked.

| Theme | `--fg-muted` | `--fg-faint` |
| --- | --- | --- |
| Tokyo | unchanged | `#555a74` → `#6a7090` |
| Graphite | `#a9a8a3` → `#c5c4c1` | `#777872` → `#a0a19c` |
| Cappuccino | `#7e665d` → `#745e56` | `#a88d81` → `#987769` |
| Mint | unchanged | `#7f9489` → `#687d72` |

Adding `--bg-elevated` to the semantic families' floor then found 12 more
failures, all real: toast backgrounds are `--bg-elevated` and their icons
use `--green` / `--red` / `--yellow` / `--accent-text`, and
`.ss-item.is-selected` is `--accent-text` on an elevated dropdown. Fixed
by the same lightness-only method.

### 1g. `--yellow-solid` / `--favorite-solid` are fill-only

Held to the 3:1 UI-component floor rather than AA, which is correct — all
four uses are `background`, `border-color` or `box-shadow`, and they are
only ever drawn inside the Presets browser. That makes 3:1 an assumption
about how they are used, not a property of the values, so a test now
asserts neither is ever used as a `color:`. If one becomes text, the floor
is wrong and the suite says so.

---

## 2. Hardcoded colors that break with more themes

There are ~20 spots where a literal black or white was used as shorthand
for "a bit darker / lighter than the surface." These already misbehave in
Cappuccino; two more themes make them worth fixing properly. **This is the
largest work item.**

### 2a. On-accent text — replaces a growing override list

`style.css:917` sets `.btn-primary { color: #0a0e1a }`, then
`style.css:924-928` overrides it with a selector list
(`.btn-primary`, `.chat-message.user .chat-avatar`,
`.chat-message.assistant .chat-avatar`) for Cappuccino. The mockup copies
that same three-selector block twice more. With four themes it is
maintained in four places, and any new accent-filled component must be
added to all of them.

Replace with tokens set once per theme block:

- `--on-accent` — text/icon on an `--accent` fill
- `--on-magenta` — text/icon on a `--magenta` fill (assistant avatar,
  `style.css:3326`)

Contrast all passes: Tokyo 7.12, Graphite 6.85, Cappuccino 10.58, Mint 14.24.

### 2b. Chat surfaces use black overlays

`style.css:3353, 3362, 3381, 3491, 3502, 3524, 3529, 3530` — inline
`code`, `pre`, the code-block container, reasoning bodies, blockquotes and
table rows are all `rgba(0, 0, 0, 0.14–0.3)`. In Mint and Cappuccino these
render as muddy dark patches inside a pale UI.

New tokens: `--code-bg`, `--inset-bg`, `--table-header-bg`. Light themes
get subtly *dark-tinted but still light* values, e.g.
`rgba(26, 32, 26, 0.06)`.

### 2c. White overlays invisible on light themes

- `style.css:3392, 3439` — code-block headers at `rgba(255,255,255,0.03)`
- `style.css:1999` — progress-bar shimmer at `rgba(255,255,255,0.15)`
- `style.css:911` — `.btn:hover` border at `rgba(255,255,255,0.14)`;
  should simply be `var(--border-strong)`

### 2d. Remaining literals

| Location | Current | Fix |
| --- | --- | --- |
| `style.css:1750` | error text `#ffb8c5` | `var(--red)` or a `--red-fg` token |
| `style.css:1247-1248` | spinner `rgba(255,255,255,0.35)` / `#fff` | `currentColor` + opacity — a white spinner is wrong on Graphite's copper button, which has dark text |
| `style.css:1577` | flag submenu `rgba(0,0,0,0.08)` | `--inset-bg` |
| `style.css:2979` | modal scrim `rgba(0,0,0,0.6)` | `--scrim` |
| `style.css:4024` | dropdown shadow `rgba(0,0,0,0.3)` | existing `--shadow-*` |
| `manager.js:796` | sets `style.background = "var(--accent)"` | fine as-is (token reference, not a literal) |

### 2e. Tokyo's palette baked into `rgba()` literals

Found during step 1a, not in the original survey. Several rules need a
palette color *with alpha*, and since `--cyan` etc. are opaque hex, the RGB
was written out by hand:

| Line | Literal | Is |
| --- | --- | --- |
| `style.css:578` | `rgba(92, 200, 240, …)` | `--cyan` |
| `style.css:579` | `rgba(180, 142, 250, …)` | `--magenta` |
| `style.css:585` | `rgba(108, 155, 255, 0.06)` | `--accent` |
| `style.css:927` | `rgba(255, 107, 138, 0.2)` | `--red` |
| `style.css:1593` | `rgba(108, 155, 255, 0.18)` | `--accent` |

These render **Tokyo's blue, cyan and magenta inside Cappuccino today** —
live bugs, not just future ones. `tokens.css` already has the right
convention (`--green-subtle` / `--green-border`, etc.); cyan and magenta
were simply never given the pair. Fixed by adding `--cyan-subtle`,
`--cyan-border`, `--magenta-subtle`, `--magenta-border`, plus `--accent-wash`,
`--accent-subtle-hover` and `--red-subtle-hover`.

### 2f. Theme-specific selector blocks to delete

- `style.css:15-19` — `:root[data-theme="cappuccino"] body` hardcodes the
  Cappuccino gradient hues. Make it token-driven: `--body-gradient-top` /
  `--body-gradient-bottom` (or a single `--body-bg`) so each theme block
  is self-contained.
- `style.css:2935-2953` — Cappuccino Presets overrides use literal
  `rgba(255, 250, 242, …)`. Same treatment.

---

## 3. Theme registry instead of hardcoded names

Three places hardcode the two theme names:

1. `theme-ui.js:6` — `SUPPORTED_THEMES` set
2. `theme-ui.js:23` — `theme === "cappuccino" ? "light dark" : "dark light"`.
   This **must** become a per-theme property, or Mint (light) and Graphite
   (dark) get the wrong `color-scheme` hint.
3. `index.html:15-16` — the pre-paint script only checks for
   `"cappuccino"`. It needs to apply any stored value, **validated against
   the allowlist inline** (do not write a raw `localStorage` string into a
   DOM attribute), and must stay inline/blocking to avoid a flash of the
   wrong theme.

Collapse all three into one array:

```js
const THEMES = [
    { id: "tokyo",      label: "Tokyo",      hint: "Dark",  scheme: "dark",  swatchBg: "#161824", swatchAccent: "#6c9bff" },
    { id: "graphite",   label: "Graphite",   hint: "Mid",   scheme: "dark",  swatchBg: "#383b41", swatchAccent: "#d9a05b" },
    { id: "cappuccino", label: "Cappuccino", hint: "Light", scheme: "light", swatchBg: "#fff4e6", swatchAccent: "#4b3832" },
    { id: "mint",       label: "Mint",       hint: "Light", scheme: "light", swatchBg: "#e3f0e9", swatchAccent: "#2f7d54" },
];
```

This drives normalization, the `color-scheme` meta hint, and the dropdown's
rendering (including swatches) from a single source.

### 3a. Drop the "default theme = no attribute" special case

`applyTheme` calls `removeAttribute("data-theme")` for Tokyo
(`theme-ui.js:28-32`), so Tokyo's palette lives in bare `:root` alongside
the structural tokens (spacing, radius, fonts, easing). That works with two
themes; with four it makes Tokyo structurally unlike its peers and means
`:root` is doing two unrelated jobs.

Proposed:

- `:root` keeps **only** non-color tokens, plus Tokyo's palette duplicated
  as the no-JS fallback.
- Every palette also gets an explicit `[data-theme="…"]` block.
- The pre-paint script always sets an attribute (defaulting to `tokyo`).

---

## 4. Theme dropdown

The mockup replaces the two side-by-side sidebar buttons with a single
trigger plus a pop-up list, so new themes never cost sidebar space. This is
the right call and the visual design works as-is.

Verified: neither `.sidebar` (`style.css:54-66`) nor `.sidebar-footer`
(`style.css:251-257`) sets `overflow`, so the upward-opening popup will not
be clipped.

Open items:

- **Keyboard navigation.** The mockup script has click, outside-click and
  Escape, but with `role="menu"` / `menuitemradio` a screen-reader user
  expects Arrow Up/Down, Home/End, and Escape returning focus to the
  trigger. ~20 lines of key handling. (A styled native `<select>` would be
  free, but loses the swatches — keep the custom menu.)
- **Trigger state.** Needs `aria-expanded` plus a live label and swatch
  update. `refreshSwitcher()` (`theme-ui.js:47-53`) currently sets
  `aria-pressed` on `[data-theme-option]`; the menu wants `aria-checked` on
  items instead.
- **Trigger icon.** The generic circle is less informative than the current
  per-theme moon / coffee-cup icons. Consider showing the active theme's
  swatch in the trigger.
- `.theme-menu-item.active { color: var(--accent) }` is exactly the §1a
  problem — in Mint the active row would look identical to the inactive
  ones. Use `--accent-text`.

---

## 5. Docs and tests

- `tests/frontend/theme_ui_unit.cjs` — assumes two themes and asserts
  `aria-pressed` at lines 83, 93, 104. Update alongside §3 and §4. Worth
  adding a case asserting `color-scheme` per theme, since that is the
  regression §3 is designed to prevent.
- `docs/tests.md:73` — theme test description.
- `docs/directory.md:190` — describes `style.css` as "the dark theme
  (Tokyo Night)".
- `docs/directory.md:136, 170` — `theme-ui.js` responsibilities.

---

## Suggested sequencing

Steps 1-3 are the real work. By step 5 a new theme costs one token block
and one registry entry.

1. **Token extraction** (§2), split in two because the literals being
   replaced are currently *shared* by all themes — giving light themes
   corrected values is itself the visual change:
   - **1a — mechanical.** Every token takes the value of the literal it
     replaced, so all four themes render as before. **Done.**
   - **1b — corrected light-theme values.** Only token blocks change, so a
     regression here is a value choice, not a missed selector. Also picks
     up the three appearance-changing items deferred out of 1a: the
     `rgba(0,0,0,…)` box-shadows (`style.css:310, 330, 4000`) and the
     white spinner (`style.css:1243-1244`). **Done.**

     Cappuccino's inset alphas were derived by matching Tokyo's perceptual
     depth step (CIE ΔL\*) rather than reusing its alphas, then scaled ~1.8x:
     strict parity puts the whole four-step scale between 0.02 and 0.05,
     where rounding noise swamps the steps. Insets tint toward the theme's
     brown (`93, 57, 50`), never pure black.

     | Token | Tokyo | Cappuccino | Cappuccino swatch |
     | --- | --- | --- | --- |
     | `--inset-xs` | black 0.08 | brown 0.03 | `#faf4ec` |
     | `--inset-sm` | black 0.15 | brown 0.05 | `#f7f0e8` |
     | `--inset-md` | black 0.22 | brown 0.07 | `#f4ece5` |
     | `--inset-lg` | black 0.30 | brown 0.10 | `#efe7df` |

     `--overlay-raised` inverts on light themes — white 0.40 vs Tokyo's
     0.03. A light theme has no headroom above `--bg-surface`, so the
     raised strip works by washing the inset back out instead of adding
     white to an already-bright surface.

     `--shimmer` is deliberately *not* overridden: the progress bar is
     filled with `--accent`, which is dark in every theme.
2. **`--accent-text` / `--on-accent` / `--on-magenta`** (§1a, §2a) — delete
   the per-theme override selector blocks. Fold in `--yellow-solid` (§1e):
   it is the same fill-versus-text split, so the two are cheaper to reason
   about and review together than apart. **Done.**

   **The CSS half of the target contract now holds:** `style.css` contains
   no color literals and no `[data-theme=…]` selectors at all. A theme's
   entire appearance lives in its token block.

   Cappuccino values: `--accent-text: #a8622c` (copper), `--on-accent` /
   `--on-magenta: #fffaf2` (10.58:1 and 4.99:1 on their fills),
   `--yellow-solid: #b8791f`.

   Note for whoever does the next bulk rename: `--accent` legitimately
   stays on *compound* color properties (`border-color`, `border-left-color`
   — 11 sites) and on the CSS `accent-color` property, which fills native
   checkboxes and radios. Only plain `color:` becomes `--accent-text`.
3. **Theme registry** (§3) — JS registry, pre-paint script, `color-scheme`
   correctness. **Done.** Both halves of the target contract now hold: a
   theme is one token block plus one `THEMES` entry.

   The pre-paint script does **not** duplicate the theme list. Duplicating
   it would create a second source of truth that rots silently, so the
   stored value is shape-checked against `/^[a-z][a-z0-9-]*$/` and written
   through instead. An unrecognised name matches no palette block and falls
   back to the bare `:root` palette (Tokyo); `theme-ui.js` normalises the
   attribute once it loads. The only theme name left in `index.html` is the
   bootstrap default.

   `tokens.css` is now three blocks: structural tokens under `:root`, then
   `:root, :root[data-theme="tokyo"]` for the Tokyo palette — one block, two
   selectors, so Tokyo is the no-JS fallback *and* an ordinary theme without
   the palette being written twice — then Cappuccino.
4. **Dropdown UI** (§4) — markup, keyboard support, `aria-checked` state,
   test updates. **Done.**

   The rows are built by `renderMenu()` from `THEMES`, so `index.html` holds
   only the trigger and an empty `<ul>` — step 5 adds two themes without
   touching markup. `renderMenu()` no-ops when the list element is absent,
   keeping the module usable on pages without the sidebar.

   Divergences from the mockup, both from §4's own open items: the trigger
   shows the active theme's swatch rather than a generic circle icon, and
   the active row uses `--accent-text` (a near-black `--accent` would have
   made the active row identical to the inactive ones in Mint).

   Keyboard: Arrow Up/Down wrap, Home/End jump, Escape closes and returns
   focus to the trigger, Tab closes without stranding an open menu, and
   opening focuses the *checked* row rather than the first. `<li>` wrappers
   carry `role="none"` so they don't expose themselves as listitems inside
   `role="menu"`.

   Two older tests asserted on the `.theme-switcher` class — the Playwright
   smoke test's sidebar-overlap check and a markup-order assertion in
   `model_switch_ui_unit.cjs`. Both encode a real invariant (the model
   switcher sits above the theme control); only the selector changed.
5. **Add Graphite and Mint** (§1) — pure token blocks plus registry
   entries. **Done**, and the contract held: the entire change was two
   blocks in `tokens.css` plus two lines in `THEMES`. No markup, no
   selectors, no JS logic.

   Derived rather than eyeballed: each theme's inset scale was solved to
   match Tokyo's perceptual depth steps against its own surface, and
   `--favorite-wash` was sized against its own hover step. Follow-up review
   also composites the rest and hover washes in the contrast test, so their
   visual hierarchy cannot lower row text below its assigned floor.

   Two things the mockup did not anticipate:

   - **Graphite must flip `--shimmer` to a dark sweep.** The progress bar is
     filled with `--accent`, and Graphite's copper puts white at 2.3:1
     against it (black: 9.1:1). The `:root` comment claiming "`--accent` is
     dark in every theme" was wrong the moment a light-accent theme existed;
     corrected.
   - **Mint needs `--yellow-solid`** for the same reason Cappuccino did —
     its `#8a6d2f` warning gold is too low-chroma to work as a fill.

   Graphite and Mint each inherit 4 tokens deliberately: `--panel-wash`
   (defined as `var(--bg-surface)`, so it re-resolves per theme),
   `--body-gradient-top`/`-bottom` (transparent = no wash), plus Graphite's
   `--scrim` and Mint's `--shimmer`.

   A test now asserts every registry entry has a matching palette block, so
   a theme can't be offered in the menu while rendering as the fallback.

## New tokens introduced

Added in step 1a. The single `--code-bg` / `--inset-bg` / `--table-header-bg`
sketch became a four-step `--inset-*` scale instead: the seven distinct
black-overlay alphas in use are all the same *concept* at different depths,
and naming them by component would have meant seven tokens that each theme
has to keep mutually consistent by hand.

| Token | Purpose |
| --- | --- |
| `--inset-xs` … `--inset-lg` | Recessed surfaces, four depth steps (code, blockquotes, reasoning bodies, table rows, flag submenu) |
| `--overlay-raised` | Hairline highlight on a raised strip (code-block headers) |
| `--shimmer` | Progress-bar sweep highlight |
| `--scrim` | Modal backdrop |
| `--red-fg` | Error text on `--red-subtle` |
| `--yellow-glow` | Preset warning-dot glow |
| `--panel-wash` | Presets browser / save bar / detail panel |
| `--body-gradient-top` / `--body-gradient-bottom` | Body background wash; `transparent` means none |
| `--cyan-subtle` / `--cyan-border` | Completes the palette-pair convention (§2e) |
| `--magenta-subtle` / `--magenta-border` | Same |
| `--accent-wash` | Faint accent gradient behind card headers |
| `--accent-subtle-hover` / `--red-subtle-hover` | Hover one step up from the `-subtle` pair |

Still to come:

| Token | Purpose | Section |
| --- | --- | --- |
| `--accent-text` | Accent applied to text/icons | 1a |
| `--on-accent` | Text/icon on an `--accent` fill | 2a |
| `--on-magenta` | Text/icon on a `--magenta` fill | 2a |
| `--shadow-inset` | Recessed inner shadow (model-switcher track) | 1b |
