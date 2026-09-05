# UI/UX polish direction

Date: 2026-09-05  
Status: Design discussion and reference mockups; product implementation has not started.

## Purpose and audience

Llama GUI is gaining users, and its interface should feel more cohesive and deliberate while retaining its technical depth and personality.

The primary audience for this work is **experienced llama.cpp users**, as specified by the project owner. The design direction is a compact technical workspace: fast to scan, precise to edit, and clear about which configuration is running.

The owner responded positively to the initial direction and Configure concept, then requested a static Quick Launch mockup. These notes preserve that discussion. Individual details and the implementation order remain proposals, rather than a commitment to implement every item.

Workflow preference: do not use the Ponytail skill for this UI/UX work.

## Saved mockups

| Mockup | Browser preview | Editable source | What it demonstrates |
| --- | --- | --- | --- |
| Configure | [configure-concept.html](ui-ux-mockups/configure-concept.html) | [source/configure-concept.html](ui-ux-mockups/source/configure-concept.html) | Aligned setting rows, running versus next-launch values, modified-only filtering, and change review. |
| Quick Launch | [quick-launch.html](ui-ux-mockups/quick-launch.html) | [source/quick-launch.html](ui-ux-mockups/source/quick-launch.html) | A static full-page composition with preset shortcuts, compact tuning controls, and one launch bar. |

Open the browser-preview HTML files in a modern browser. They are standalone exports and do not require the Llama GUI server or a Codex session. The export includes a preview wrapper; icons or other presentation resources may require an internet connection.

The source files are the original HTML fragments, preserved for future editing. To regenerate a preview in Codex, use the visualization skill's export workflow on the corresponding source fragment. Keep source and preview together when updating a design.

The Configure preview supports editing its example numeric values, toggling **Modified only**, reviewing differences, and reverting to its example running values. It never restarts a server or writes application state. Optional design controls from the original conversation are host-provided and are not required by the standalone preview.

Quick Launch is deliberately static: its controls are inert. Model names, preset names, runtime versions, settings, and other values in both mockups are illustrative. They are not proposed changes to application defaults or evidence of an installed/running model.

## What the review found

The review covered the architecture and frontend structure, the repository's screenshots, and the live idle Quick Launch and Configure screens. No inference session was launched. The running-state screenshots provided visual context; this was not a complete lifecycle or accessibility audit.

The main concern is hierarchy. Features have accumulated their own panels, explanations, badges, and actions, which makes the application feel assembled from separate pieces.

Concrete examples:

- Quick Launch's Model card contains two fields but stretches to match the much taller Launch Mode card. More frequently adjusted controls sit further down the page.
- Configure initially presents 17 collapsed categories. Expanded categories have tall rows with descriptions, default values, and repeated help disclosures.
- Runtime controls and information are distributed across the sidebar footer, page-specific badges, launch areas, and bottom metrics bar.
- Monitor appears under **Setup**, while Benchmarking appears under **Manage**, even though both relate closely to configuration and experimentation.
- API endpoint URLs wrap inside narrow cards.
- The Chat screenshot gives substantial space to both conversation history and settings, reducing the central conversation width.
- Installation status uses error-like styling for some absent optional tools.

Useful foundations already exist: shared flag state, searchable model selectors, theme tokens and contrast tests, preset management, process lifecycle orchestration, collapsible Chat panels and Focus mode, and Monitor customization. Reuse these foundations when implementing the design.

## Design principles

1. **Optimize for repeated technical work.** Keep CLI names and precise values available; make common changes require less scanning and scrolling.
2. **Make state explicit.** Separate the active runtime, settings being edited, and the saved preset from which those settings came.
3. **Use progressive disclosure.** Keep essential settings and meaningful summaries visible. Put detailed explanations and infrequent management actions one step away.
4. **Make density readable.** Align labels and values, use consistent input widths, and preserve legible type rather than shrinking everything.
5. **Give actions a consistent hierarchy.** Make the current page's main action easy to identify and reduce duplicated action clusters.
6. **Use restrained styling.** Keep the llama identity and existing themes. Reduce decorative borders, colored icon tiles, glows, and repeated status boxes. Use color primarily for selection, changes, and operational status.
7. **Preserve capabilities.** A collapsed or omitted control in a concept is not a decision to remove the feature.

## Configure: proposed first focus

Make Configure the flagship screen for experienced users.

### Setting rows and navigation

- Show readable setting names alongside CLI flags.
- Align setting names, values, and relevant comparison values in consistent columns.
- Provide compact rows with detailed help available on demand.
- Keep the existing search, which already covers flag names, labels, descriptions, and option labels.
- Add a modified-only view and per-setting reset.
- Show category summaries such as **3 modified**, so users can find their overrides without opening every category.
- Treat beginner explanations as optional help while retaining important compatibility and validation messages.

### Running versus next launch

The saved concept shows four Context & Memory rows, with two changes relative to an example running configuration. Its **Next launch** and **Running** columns make the comparison explicit. **Review changes** opens a concise list of old and new values; **Revert to running values** restores the example baseline.

Production behavior needs separate meanings for:

- Values that differ from defaults.
- Values that differ from a loaded saved preset.
- Values that differ from the running configuration.

The mockup's **Modified only** filter uses the running configuration as its baseline. The final label and baseline policy remain to be decided; these meanings must not be silently combined.

Default markers must also identify whether they refer to GUI defaults, model defaults, or a verified runtime value. Unknown runtime values should remain unknown rather than being filled in from pending settings.

## Shared runtime presentation

Bring the active model, backend/build, endpoint, and lifecycle state into one persistent runtime summary.

- Distinguish stopped, starting/loading, ready, stopping, and failed states using authoritative lifecycle information.
- When edits differ from the running configuration, show a concise count such as **2 changes for next launch**, with an inspectable comparison.
- Distinguish settings that need a process restart from Chat settings used on subsequent requests. Determine applicability from the existing request and launch paths rather than assuming all settings behave alike.
- Keep estimated memory for a prospective launch distinct from measured usage of the active runtime.
- Use explicit action labels, such as **Launch server**, **Stop server**, or **Quit Llama GUI**. The current **Stop Python Server** label describes implementation rather than the user's result.
- Continue masking/redacting secrets in previews and comparisons.

The preview only illustrates presentation and local comparison. It does not specify a new restart confirmation policy, implement restart behavior, or establish that every required comparison value is currently available.

## Quick Launch: proposed composition

The static mockup places the most frequent decisions and the launch action together. It replaces the tall independent cards with a compact configuration panel and a few secondary disclosure rows.

### Layout, top to bottom

1. **Runtime strip:** current process state and installed backend/build. The example shows **Server stopped**.
2. **Page header:** Quick Launch and a direct **Open Configure** action.
3. **Saved presets:** compact shortcuts for repeat sessions and a **View all** entry to the preset library. The example shows Daily chat and Long context, with Daily chat selected.
4. **Model:** a full-width model picker, Refresh, Download model, the model folder, and access to changing the folder.
5. **Launch mode:** a compact choice between Web / API server and Terminal.
6. **Memory & GPU:** context length, GPU offload, and Auto Fit, with advanced fit options behind a disclosure and a concise headroom summary.
7. **Sampling:** sampler preset plus directly editable Temperature and Top P. Remaining sampling controls stay available through **More sampling settings**.
8. **Server & template settings:** a disclosure with visible summaries for port, API-key state, and template selection.
9. **Model Switcher:** a compact collapsed row with the assigned preset names, retaining access to slot management.
10. **Launch bar:** readiness, a concise configuration summary, **View command**, and a clear **Launch server** action.

Memory/GPU and Sampling sit side by side on desktop and stack at narrower widths. The mockup includes a simplified app shell to show the proposed visual hierarchy.

### Behavior to preserve or resolve during implementation

- All controls must continue reading and writing the same flag, template, and sampler state as Configure, Chat, and command preview.
- Preset shortcuts must reference the existing preset library. Choosing which presets appear—favorites, recent use, explicit pinning, or another rule—is an open decision.
- Distinguish saved full launch presets, starter profiles, and sampler presets. The mockup emphasizes saved presets; it does not decide to delete the current starter profiles.
- Selecting a preset after edits needs predictable behavior, including an accurate selected/modified indication. A selected shortcut must not continue implying an exact match after settings change.
- Keep all current sampler controls and load/save/rename/delete capabilities accessible, even though the static mockup shows only the common controls.
- Preserve custom context and GPU values, metrics controls, API-key handling, template options, downloads, and existing command-parser validation.
- Preserve Model Switcher assignment, launch, switch, cancellation, recovery, and accidental-switch protections. Standby remains a saved configuration, not a second resident model.
- Keep readiness and errors next to the action they affect. Disabled actions need a visible reason; failures need an actionable recovery path.
- Retain access to global runtime actions while deciding how to reduce duplication with page-local launch controls.
- At narrow widths, provide working access to navigation and model-folder controls. The static shell simplifies these details and is not a complete mobile interaction specification.
- The mockup's launch bar sits at the bottom of the composition. Sticky positioning and behavior during long forms or open disclosures need a separate implementation decision.

## Navigation and other screens

### Navigation

Group Configure, Monitor, and Benchmarking around the tuning/experimentation workflow. Keep Chat and API adjacent, give Presets a clear library entry, and place installation/update maintenance lower in the navigation.

The mockup puts Quick Launch first and illustrates this grouping. It does not decide the default landing tab or merge Quick Launch and Configure. A stronger connection between Presets and Configure should show the loaded preset name and whether it has unsaved changes.

### Visual consistency

- Standardize page-header spacing, input sizes, section spacing, and action placement.
- Reduce repeated card outlines and nested surface treatments.
- Reduce decorative colored icon tiles, hover gradients, and button glows where they compete with operational information.
- Keep important labels and values readable; compactness should come primarily from layout and reduced repetition.
- Preserve all supported themes and the project's contrast floors.

### Chat

Build on existing Focus mode and collapsible history/settings panels. Remember users' preferred layout, give the conversation more space, and reduce persistent sampler/help text. A new chat architecture is not part of this direction.

### API

Present endpoints as compact rows so long URLs are easier to read and copy. Treat connecting an external server and enabling remote access as distinct secondary sections. Retain meaningful remote-access warnings and authentication information.

### Install and Update

Show absent optional tools neutrally unless their absence blocks the selected task. Improve user-facing lifecycle labels, especially the distinction between stopping llama-server and quitting Llama GUI.

### Presets and Monitor

Their existing functionality provides a useful foundation. Refine hierarchy and consistency in a later pass, keeping Presets closely connected to editing and launch, and Monitor closely connected to the active runtime.

## Suggested implementation sequence

This order is a recommendation from the discussion; the owner has not yet selected an implementation slice.

| Slice | Scope | Review criteria |
| --- | --- | --- |
| 1. Configure presentation | Compact rows, aligned values, help disclosure, and clear category summaries. | Common edits require less scrolling; keyboard access, validation, search, and shared-state synchronization remain intact. |
| 2. Configuration comparisons and runtime summary | Define comparison baselines; expose meaningful pending changes and active-runtime identity. | Running and pending values never get mixed; unavailable information and secrets are handled correctly; lifecycle transitions remain accurate. |
| 3. Quick Launch layout | Preset shortcuts, unified compact controls, secondary disclosures, launch bar. | Existing launch capabilities remain reachable; selection/modified states are truthful; common launch preparation fits a normal desktop viewport. |
| 4. Shell and secondary screens | Navigation grouping, shared visual treatments, Chat/API/Install refinements. | Cross-screen consistency improves without making existing tasks harder to find. |

The initial recommendation was to start with Configure and the running-versus-pending distinction because these improve everyday work for the primary audience and establish reusable patterns. Quick Launch can be selected first if that becomes the owner's preferred starting point.

## Open decisions

- Which implementation slice should come first?
- Which baseline should each modified indicator, filter, and reset use?
- Which saved presets should Quick Launch surface, and where should starter profiles live?
- How should preset selection and unsaved edits be presented?
- How much explanatory text should be visible by default? Is a density preference useful?
- Where should the shared runtime summary and global runtime actions live?
- Should the launch bar become sticky, and how should it behave on small screens?
- Should navigation changes ship with a page redesign or in a separate pass?
- Should the default landing tab change? Quick Launch and Configure remain separate in the current concepts.

These can be resolved as their implementation slices become concrete; they do not all need to be decided upfront.

## Implementation guardrails and verification

Follow [AGENTS.md](../AGENTS.md), [the project reference](directory.md), and [the test guide](tests.md). Mockup styling and example values are design references, not production code to copy wholesale.

- Reuse the existing vanilla frontend and focused `window.LlamaGui` modules.
- Write flag state through the existing setters; never mutate `flagCore.getFlagValues()` directly.
- Reuse shared flag definitions, chat-template options, sampler state, and preset helpers.
- Keep platform decisions in the backend and preserve lifecycle orchestration and authoritative runtime identity.
- Keep production theme colors in `ui/css/tokens.css`. Preserve AA text contrast and the established 3:1 floors for faint/fill-only tokens.
- Use semantic controls, visible keyboard focus, accessible disclosures, and readable error states. Preserve operation on narrow screens and at browser zoom.
- Keep Custom Launch Args parse errors blocking launch and visible near the textarea. Keep sensitive values out of previews and saved presets.
- Preserve script dependency order and update documentation if scripts or routes change.
- Add a dated changelog entry when product behavior or styling changes. This design-document/export-only change does not need one.

For implementation, run `node --check` on changed JavaScript and `npm run test:frontend` for DOM wiring, mirrored controls, shared-state, or command-preview changes. Run the theme unit test for theme changes and the project-venv backend suite if backend code changes. Choose other focused tests using `docs/tests.md`.

Visual review should cover long model/preset names, empty libraries, selected and modified presets, launch readiness and errors, lifecycle transitions, unavailable telemetry, light/dark themes, keyboard navigation, and narrow layouts. Reuse existing tests and add focused coverage only where behavior changes require it.
