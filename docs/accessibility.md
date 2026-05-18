# Accessibility Review

This note captures a first-pass accessibility review of the Llama GUI frontend. The app already has several good foundations: it uses native form controls heavily, many inputs have labels, color contrast is generally strong, and `prefers-reduced-motion` is present in `ui/css/tokens.css`.

## Glaring Issues

### Mouse-only Configure accordions

Configure category accordions are rendered as clickable `div` elements in `ui/js/config-flags-ui.js`. They are not keyboard-focusable, do not expose button semantics, and do not announce expanded/collapsed state.

Recommended fix:
- Render category headers as `<button type="button">`, or add equivalent `role="button"`, `tabindex="0"`, keyboard handling, and `aria-expanded`.
- Keep submenu headers consistent with category headers.
- Connect each header to its body with `aria-controls`.

### Mouse-only chat history items

Saved conversation rows in `ui/js/chat-ui.js` are clickable `div` elements. Keyboard users cannot tab to a conversation and activate it.

Recommended fix:
- Render each conversation row as a button, or make it focusable with proper role and keyboard activation.
- Preserve the nested delete button without triggering conversation loading.
- Add an active/current state such as `aria-current="true"` for the selected conversation.

### Suggestion chips are clickable spans

The chat starter prompts in `ui/index.html` are `span.suggestion-chip` elements with click handlers. They should be real buttons so they are keyboard accessible and announced as actions.

Recommended fix:
- Change the chips to `<button type="button" class="suggestion-chip">`.
- Keep the existing `data-prompt` behavior.
- Ensure the styling still looks like compact chips.

### Icon-only buttons rely on `title`

Several icon-only controls rely on `title` text for labeling. Examples include the mobile menu button, sidebar collapse/open buttons, refresh/copy buttons, and chat history/settings open buttons.

Recommended fix:
- Add explicit `aria-label` values to icon-only buttons.
- Keep `title` only as a visual hover tooltip if desired.
- For buttons that toggle a panel, add `aria-expanded` and `aria-controls`.

### Some labels are visual-only

A few labels are missing `for` attributes or are used as plain text near a control rather than being programmatically associated. Examples include Install Version/Backend and Configure Tool/Command Preview labels.

Recommended fix:
- Add `for` attributes where a label describes one control.
- Use `aria-labelledby` or grouped fieldsets where one label describes multiple related controls.
- For non-input output areas such as command preview, use a heading or `aria-labelledby` instead of a form label.

### Sidebar tab navigation lacks panel semantics

The sidebar navigation is implemented as buttons that show/hide panels. It works visually, but the active panel relationship is not exposed to assistive technology.

Recommended fix:
- Either treat the sidebar as navigation and expose active state with `aria-current="page"`, or implement tab semantics with `role="tablist"`, `role="tab"`, `aria-selected`, and `aria-controls`.
- Ensure hidden panels are not announced when inactive.

### Dynamic status areas need live regions

Only the custom launch args status currently uses `aria-live="polite"`. Other dynamic areas, such as install status, HF download status, remote tunnel status, progress updates, and toast messages, do not consistently announce changes.

Recommended fix:
- Add `role="status"` or `aria-live="polite"` for non-critical status updates.
- Add `role="alert"` only for urgent errors.
- Give the toast container an appropriate live-region role.
- Avoid announcing very noisy polling updates unless the message actually changes in a user-meaningful way.

## Contrast Notes

Most theme colors in `ui/css/tokens.css` have good contrast on the dark backgrounds. The main foreground, muted text, accent, red, green, yellow, cyan, magenta, and primary button text all checked out well in a rough contrast pass.

One caveat: `--fg-faint` is low contrast and should remain decorative or supplemental only. Do not use it for important labels, instructions, status text, or actionable content.

## Suggested Priority

1. Convert clickable `div` and `span` controls to native buttons where possible.
2. Add `aria-label`, `aria-expanded`, and `aria-controls` to icon-only and toggle controls.
3. Add live-region semantics to status and toast areas.
4. Tighten label associations for remaining form controls and output areas.
5. Decide whether sidebar sections should be navigation or true tabs, then expose the chosen semantics consistently.
