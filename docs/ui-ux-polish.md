# UI/UX polish direction

Date: 2026-09-05  
Status: Configure presentation, launch-settings comparison, restart with changes, Quick Launch layout, sidebar navigation/runtime controls, shared visual treatments, Chat/API/Install refinements, and Monitor's active-runtime pass implemented. Further Presets workflow changes and comparison-baseline decisions remain optional follow-ups.

## Purpose and audience

Llama GUI is gaining users, and its interface should feel more cohesive and deliberate while retaining its technical depth and personality.

The primary audience for this work is **experienced llama.cpp users**, as specified by the project owner. The design direction is a compact technical workspace: fast to scan, precise to edit, and clear about which configuration is running.

The owner responded positively to the initial direction and Configure concept, requested a static Quick Launch mockup, and agreed to start implementation with Configure. These notes preserve the discussion and implementation progress. Details in later slices remain proposals, rather than a commitment to implement every item.

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

## Configure: first focus

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

The mockup's **Modified only** filter uses its example running configuration as the baseline. Production uses **Changed since launch**, comparing current GUI inputs with the snapshot submitted for the active local process. The comparison column is labeled **At launch**: these are configured inputs, not effective runtime values resolved by Auto Fit, model defaults, or custom overrides. Default and saved-preset comparisons remain separate future work.

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

The lower-left **Install & Update** entry in the Quick Launch mockup opens a dedicated page within the app, like the existing tab. Its placement groups maintenance separately from everyday launch and tuning work. A small update-available badge is an optional future refinement.

Show absent optional tools neutrally unless their absence blocks the selected task. Improve user-facing lifecycle labels, especially the distinction between stopping llama-server and quitting Llama GUI.

### Presets and Monitor

Their existing functionality provides a useful foundation. Refine hierarchy and consistency in a later pass, keeping Presets closely connected to editing and launch, and Monitor closely connected to the active runtime.

## Suggested implementation sequence

The owner selected Configure as the starting point. The remaining order is a recommendation from the discussion.

| Slice | Scope | Review criteria |
| --- | --- | --- |
| 1. Configure presentation | Compact rows, aligned values, help disclosure, and clear category summaries. | Common edits require less scrolling; keyboard access, validation, search, and shared-state synchronization remain intact. |
| 2. Configuration comparisons and runtime summary | Define comparison baselines; expose meaningful pending changes and active-runtime identity. | Running and pending values never get mixed; unavailable information and secrets are handled correctly; lifecycle transitions remain accurate. |
| 3. Quick Launch layout | Preset shortcuts, unified compact controls, secondary disclosures, launch bar. | Existing launch capabilities remain reachable; selection/modified states are truthful; common launch preparation fits a normal desktop viewport. |
| 4. Shell and secondary screens | Navigation grouping, shared visual treatments, Chat/API/Install refinements. | Cross-screen consistency improves without making existing tasks harder to find. |

Configure and the running-versus-pending distinction improve everyday work for the primary audience and establish patterns for Quick Launch.

### Implemented: Configure presentation, 2026-09-05

- Readable setting names beside CLI switches, using the existing shared definitions.
- Aligned input columns, row separators, and full-width layouts for paths and compound controls; stacked rows on narrow screens.
- Short descriptions stay visible, including compatibility warnings. Detailed explanations and beginner tips share one optional **Details** disclosure.
- Defaults are explicitly labeled **GUI default**.
- Native category buttons with expanded/collapsed state, associated setting labels, and accessible submenu disclosures.
- Browser coverage for label focus, keyboard disclosure controls, aligned inputs, narrow-layout containment, and existing shared-state synchronization.

### Implemented: Configure launch comparison, 2026-09-05

- Configure shows active lifecycle state, model/tool, endpoint, and launch-time backend/build when available.
- Successful manual and Model Switcher launches retain their GUI input snapshot on the backend, tied to the process generation. It survives browser reloads and is removed with the process.
- **At launch** values appear beside editable controls. Changed rows and category counts use that baseline; **Changed since launch** combines with the existing search.
- **Review changes** includes changed settings outside the current search. Per-setting **Use launch value** and bulk **Revert compared settings** update shared state without launching, stopping, or modifying the selected model.
- Unset recorded inputs remain unset. Unrecorded fields display **Unknown**; stopped processes, external servers, older launches without snapshots, and a different selected tool have no inferred baseline.
- API keys and Custom Launch Args are excluded from snapshots/comparisons. A boolean records whether custom arguments were present so the UI can explain possible overrides without storing their text twice. Sampler edits also affect subsequent built-in Chat requests.
- Model selection and models-folder differences are identified separately from the setting count. GUI input differences may include currently inactive controls; they do not claim a measured change in effective runtime behavior.
- Verification covers snapshot isolation, invalid metadata, redaction, lifecycle replacement/exit, shared-state reverts, filtered editing focus, and desktop/narrow layouts.

The comparison summary lives in Configure; Quick Launch has a compact runtime strip, and the sidebar now carries a shared runtime disclosure across pages.

### Implemented: Restart with changes, 2026-09-05

- **Restart with changes** in Configure reloads the local llama-server using the selected model and all pending launch settings, including fields excluded from comparison. The nearby description makes the interruption of active requests explicit.
- Argument parsing and backend preflight happen before stopping. The shared lifecycle confirms the original process has stopped, launches the captured configuration, and waits for readiness. Inline errors and progress labels keep the action visible.
- The action is disabled during transitions and cancels if another process replaces the original during validation. Changes made while restart is in progress remain pending for the next launch.
- The button remains available when compared settings match, since Custom Launch Args and API keys are intentionally absent from the change count. External servers and other tools do not offer this action.

### Implemented: Quick Launch layout, 2026-09-05

- One compact panel brings model selection, launch mode, Memory & GPU, and Sampling together. Direct Temperature and Top P fields supplement the existing sliders and share the same flag state as Configure and Chat.
- Three full-preset shortcuts prioritize favorites, then recent use, then name. Archived and legacy partial presets stay in the library. **View all** opens Presets; loading a shortcut replaces pending settings without starting a process.
- Shortcuts indicate **Matches settings** or **Modified · load again**, comparing current savable inputs with the saved configuration through the preset module. API keys remain outside this comparison and are preserved on load. A preset can match without having been loaded through a shortcut.
- The runtime strip uses authoritative lifecycle/model/build/endpoint data. The launch bar describes pending settings; its endpoint link points to the active server when present and otherwise previews the next launch, with an explicit label for each. Launch/stop labels reflect the pending tool and active process respectively.
- Server, API key, metrics, port, and template controls share a disclosure. Additional sampling controls and sampler save/rename/delete remain under **More sampling settings**. Starter profiles and the downloader sit below the launch bar; the model row has a direct Download model action.
- Model-folder change/reset controls reuse the existing manager path. Model Switcher remains a compact row with its assignment and switching behavior intact.
- The launch bar stays in normal document flow so expanded controls and narrow screens are not covered by a floating action area. Common controls and the launch action fit a 1440 × 1000 desktop viewport and stack at narrow widths.
- Browser coverage checks favorite/recent ordering, empty/error preset lists, safe long names, matching/modified states, shared numeric inputs, keyboard disclosures, runtime/pending separation, download access, and narrow-screen containment. Dark and light themes were reviewed.

### Implemented: Sidebar navigation and runtime controls, 2026-09-05

- Quick Launch stays first and remains the default page. **Tune** groups Configure, Monitor, and Benchmarking; **Interact** groups Chat and API; **Library** contains Presets.
- Install & Update opens its existing page from the lower maintenance area. The installed build sits beside maintenance; theme selection and **Quit Llama GUI** remain accessible below it.
- A compact runtime disclosure shows authoritative lifecycle state and the active model across pages. Expand it for the active tool/build and endpoint, plus Open Monitor or Open API for an external server. Pending model and port edits never substitute for the active identity.
- Launch/stop controls share existing readiness and process actions, with explicit labels and visible reasons for unavailable launches. Stop is disabled during stopping. Quit retains the existing confirmation and is separated from process actions.
- Prospective memory figures are labeled **Next launch**. Model Switcher remains available with its existing drag and keyboard protections, with quieter styling.
- Short windows can scroll the sidebar. Mobile navigation has Close, Escape and backdrop dismissal, keyboard focus containment, current-page semantics, and no tab stops in the hidden sidebar.
- Shared visual treatments and Chat/API/Install refinements are implemented below; broader Presets/Monitor workflow refinements remain possible follow-ups.

### Implemented: Visual consistency, 2026-09-05

- Shared page headings and wrapping action bars across the app, including Chat. Each page uses a semantic level-one heading, with consistent title sizing and spacing.
- Shared standard and compact control heights align inputs, searchable selectors, and neighboring buttons. Form groups and help text use consistent spacing without doubling margins inside rows.
- Quiet, stationary cards with consistent corner radii and neutral heading icons. Removed decorative hover strips, card lift, and primary-button glows; selection, keyboard focus, and operational status retain emphasis.
- Simplified nested Installed and API surfaces, matched Chat panels to the shared card treatment, and allowed API endpoint columns to fit narrow screens. The subsequent secondary-screen pass below adds endpoint rows and Chat layout refinements.
- Preserved existing theme palettes and contrast floors. Verified the full frontend suite and checked page/control containment at a 390-pixel layout.

### Implemented: Secondary screens, 2026-09-05

- **Chat:** Conversations and Settings open from labeled header buttons instead of tall side rails. Both panels default to collapsed when there is no saved choice; existing settings preferences are honored. Explicit panel choices survive reloads. Narrow layouts collapse panels temporarily, and widening restores the saved choice without overwriting it. Hidden panels are inert, and focus follows their visible controls. Focus mode remains temporary and preserves the panel layout underneath it.
- **Chat settings:** Sampler names label their sliders, values remain visible, and routine explanations share a **Sampler reference** disclosure. Thinking compatibility warnings remain visible; the system prompt has an accessible label. Shared sampler state and request behavior are unchanged.
- **API:** Each endpoint has an aligned name, method, full URL, description, and specifically labeled Copy action. External-server connection and remote access use separate disclosures at the top, with status badges visible while collapsed. The remote-access warning stays beside the tunnel controls. Client examples expand individually (cURL opens initially) and retain their open state when model/auth settings trigger a rerender.
- **Install & Update:** Required launch tools stay visible; optional tools live under an installed-count summary and show neutral **Not installed** text when absent. Missing required files and repair guidance retain their warning treatment. Status polls preserve optional-tool disclosure focus and open state. **Restart Llama GUI** replaces the implementation-specific restart label while keeping the existing confirmation.
- **Verification:** Frontend syntax, unit, theme contrast, flag compatibility, and browser checks passed. Browser coverage includes panel reload/resize/focus behavior, disclosure keyboard access, endpoint containment at 390/900/1440px, retained client examples, and required/optional installation states.

### Implemented: Monitor runtime connection, 2026-09-05

- Active model/tool/backend/build/endpoint and lifecycle state use the shared authoritative runtime. Pending edits never replace that identity. Open Configure and Review changes link back to the existing launch comparison; reviewing expands and focuses it without applying settings or restarting. Model/folder changes can link to the comparison even when the compared flag count is zero.
- System telemetry has its own Live/Stale/Paused label. CPU, memory, disk, and GPU readings describe this machine, including other applications; inference readings come directly from the connected llama-server. Vendor GPU tools are optional for Monitor's other capabilities.
- GPU setup and probe diagnostics are behind a keyboard-operable disclosure with Recheck. Available GPU cards remain in the metrics grid. Existing card ordering/hiding preferences and backend-specific guidance are preserved.
- Inference notes explain loading, non-server tools, and independently unavailable metrics/slots without replacing valid readings or claiming missing data is zero. Active requests are labeled Processing, since they may be processing a prompt or generating output.
- Empty idle output no longer reserves a large blank terminal. Retained stopped-process output is labeled Last run output. External connections identify their endpoint and explain the absence of process output.
- External target changes invalidate delayed inference polls before establishing a new baseline, including reconnects to the same address.

## Remaining decisions

- How should separate default and saved-preset comparisons be exposed alongside the implemented launch baseline?
- Should Quick Launch preset shortcuts eventually support explicit pinning in addition to favorites/recent use?
- How much explanatory text should be visible by default? Is a density preference useful?
- Should the sidebar runtime disclosure eventually include a pending-change count linked to Configure's comparison?
- Should the launch bar become sticky, and how should it behave on small screens?
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
