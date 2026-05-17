# UI Navigation Mockups

Two static HTML mockups exploring ways to reduce tab switching and improve user friendliness in the left sidebar navigation.

## Files

- `mockup-merged-interact.html` — Merged Chat + API into a single "Interact" tab
- `mockup-unified-launch.html` — Unified Configure tab with inline Quick Settings + reorganized sidebar

Both are self-contained HTML with inline CSS (Tokyo Night theme). Open directly in a browser. The toggle and accordion interactions are functional.

---

## Mockup 1: Merged Chat + API (`mockup-merged-interact.html`)

### What Changed

**Sidebar:** Unchanged (still 6 tabs) for direct comparison with the current layout.

**Chat + API → Interact:** The "Chat" and "API" nav items are replaced by a single **"Interact"** tab. Inside, a segmented toggle at the top switches between two sub-views:

- **Chat sub-view:** Same layout as the current Chat tab — message area, input bar with web search toggle, and a settings sidebar with system prompt and sampler sliders.
- **API sub-view:** Base URL, endpoint cards, Cloudflare tunnel controls, and client snippets (cURL, Python).

**Shared Info Bar:** A persistent bar sits below the header showing the base URL and live stats (prompt speed, gen speed, context usage, KV cache). This bar is always visible regardless of which sub-view is active, giving the user constant awareness of server state without switching tabs.

### What This Solves

- Eliminates one entire sidebar tab (6 → 5)
- Chat and API are both "interact with a running server" — grouping them together matches the user's mental model
- The shared info bar means stats are visible while chatting, and chat is one click away while browsing API endpoints

### What's Intentionally Omitted

- Chat history sidebar (conversations list) — omitted to keep the mockup focused; would be preserved in the real implementation
- Full set of Chat settings — only a representative sampler subset is shown

---

## Mockup 2: Unified Launch Tab (`mockup-unified-launch.html`)

### What Changed

**Sidebar reorganized (6 tabs → 5):**

| Current | Mockup |
|---------|--------|
| Install | Install |
| Quick Launch | *(removed — merged into Configure)* |
| Configure | Configure |
| Chat | Chat |
| API | API & Tunnel |
| Presets | Presets |

"Quick Launch" is removed as a standalone tab. Its controls are absorbed into Configure. "API" is renamed to "API & Tunnel" to clarify it includes tunnel management.

**Collapsible Quick Settings panel at the top of Configure:**

A new panel at the top of the Configure tab contains all the simplified controls that were previously in Quick Launch:

- Tool mode toggle (API Server / CLI Chat)
- Model selector with refresh button
- Beginner profile dropdown (Safe Defaults, Balanced, Low Memory, Long Context, Creative Chat)
- Context length preset dropdown
- GPU offload mode (Auto / CPU only / All / Custom)
- Chat template pack selector
- Auto Fit toggle + fit target
- Sampler preset selector

The panel is collapsible — power users can collapse it and go straight to the flag accordions. Beginners can leave it expanded for a guided experience.

**Existing Configure content preserved:**

Below Quick Settings, everything from the current Configure tab remains:

- Search bar with Clear / Expand All / Collapse All controls
- All flag accordions with their full contents (submenus, multi_enum, beginner tips, risk badges)
- Custom Launch Args textarea

**Sticky Launch Bar pinned to bottom of viewport:**

A fixed bar at the bottom of the screen always shows:

- Launch / Stop button
- Command preview (updates live as flags change)
- Server address + Web UI link (when running)

This replaces the current behavior where the launch bar scrolls out of view when editing flags near the bottom of Configure.

### What This Solves

- **Primary goal:** Users no longer need to switch between Quick Launch and Configure. Everything is in one tab.
- The collapsible Quick Settings panel serves the same beginner-friendly role as Quick Launch, but doesn't force a tab switch for power users.
- The sticky launch bar means the command preview and launch button are always reachable, even when deep in flag configuration.
- One fewer tab in the sidebar reduces cognitive load.

### What's Intentionally Omitted

- Only a few representative flag categories are shown (Server, Sampling, Context, Reasoning) to keep the mockup file small. The real implementation would include **all** existing Configure flags, categories, and submenus — nothing would be removed.
- HF Download panel from Quick Launch is not shown (would be added as another collapsible section or integrated into the model selector area).

---

## Notes

- These mockups are independent proposals. They can be implemented separately or combined (both changes together would reduce the sidebar from 6 tabs to 4: Install, Configure, Interact, Presets).
- All existing shared-state sync rules (AGENTS.md) apply — Quick Settings controls would write through `flagCore` setters, keeping them synchronized with Chat sidebar sliders and any remaining mirrored controls.
