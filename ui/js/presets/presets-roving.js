// Presets package (7/10): roving keyboard focus for the preset list.
// --- Roving focus -----------------------------------------------------------
// The browser list is one composite widget rather than a few hundred tab stops.
// A 58-preset library across 33 groups is 33 header buttons plus 58 rows each
// carrying a checkbox, a favorite toggle, and a Load button: 265 stops to cross.
// With roving tabindex it is one stop to enter, then Up/Down between items and
// Tab straight back out.
//
// The sequence is group headers plus the rows of expanded groups, in DOM order.
// Rows inside a collapsed group are display:none, so they are skipped entirely.
// Only the current item is reachable by Tab; its inner controls are restored to
// the tab order with it, so Tab still reaches the focused row's own buttons and
// then leaves the list.

let presetRovingKey = "";

function getPresetFocusItemKey(el) {
    if (!el || typeof el.getAttribute !== "function") return "";
    const presetName = el.getAttribute("data-preset-name");
    if (presetName !== null && presetName !== undefined) return `row:${presetName}`;
    const groupKey = el.getAttribute("data-group-key");
    if (groupKey !== null && groupKey !== undefined) return `group:${groupKey}`;
    return "";
}

function getPresetFocusItems(container) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    const items = [];
    for (const group of Array.from(container.querySelectorAll(".preset-group"))) {
        const header = group.querySelector(".preset-group-header");
        if (header) items.push(header);
        // Collapsed groups hide their list, so their rows are not focusable.
        if (group.classList && group.classList.contains("collapsed")) continue;
        items.push(...Array.from(group.querySelectorAll(".preset-item")));
    }
    return items;
}

function isPresetRowElement(el) {
    return Boolean(el && el.classList && el.classList.contains("preset-item"));
}

function setPresetFocusItemTabIndex(el, isCurrent) {
    el.tabIndex = isCurrent ? 0 : -1;
    if (!isPresetRowElement(el) || typeof el.querySelectorAll !== "function") return;
    // A row's checkbox, favorite toggle, and Load button ride with it. Left at
    // their default they would each stay a tab stop on all 58 rows, which is
    // where the bulk of the 265 came from.
    for (const control of Array.from(el.querySelectorAll("input, button"))) {
        control.tabIndex = isCurrent ? 0 : -1;
    }
}

function applyPresetRovingTabIndex(container, focusCurrent = false) {
    const items = getPresetFocusItems(container);
    if (items.length === 0) return null;

    let current = items.find((el) => getPresetFocusItemKey(el) === presetRovingKey);
    if (!current) {
        // Prefer the selected preset so keyboard focus starts where the user
        // last was, rather than snapping to the top of the library.
        current = items.find((el) => el.getAttribute("data-preset-name") === selectedPresetName)
            || items[0];
    }
    presetRovingKey = getPresetFocusItemKey(current);

    for (const el of items) {
        setPresetFocusItemTabIndex(el, el === current);
    }

    if (focusCurrent && typeof current.focus === "function") {
        current.focus();
    }
    return current;
}

function movePresetRovingFocus(container, delta, absolute = "") {
    const items = getPresetFocusItems(container);
    if (items.length === 0) return;

    const currentIndex = items.findIndex((el) => getPresetFocusItemKey(el) === presetRovingKey);
    let nextIndex;
    if (absolute === "first") {
        nextIndex = 0;
    } else if (absolute === "last") {
        nextIndex = items.length - 1;
    } else {
        // Clamped rather than wrapping: silently jumping from the last preset
        // back to the first is disorienting across a library this long.
        const from = currentIndex === -1 ? 0 : currentIndex;
        nextIndex = Math.min(Math.max(from + delta, 0), items.length - 1);
    }

    presetRovingKey = getPresetFocusItemKey(items[nextIndex]);
    applyPresetRovingTabIndex(container, true);
}

function presetListHasFocus(container) {
    if (!container || typeof container.contains !== "function") return false;
    if (typeof document === "undefined") return false;
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return container.contains(active);
}

function syncPresetRovingToFocus(container, target) {
    const items = getPresetFocusItems(container);
    const item = items.find((el) => (
        el === target || (typeof el.contains === "function" && el.contains(target))
    ));
    if (!item) return;
    const key = getPresetFocusItemKey(item);
    if (!key || key === presetRovingKey) return;
    presetRovingKey = key;
    applyPresetRovingTabIndex(container);
}

function initPresetRovingFocus(container) {
    // Bound once on the container, which outlives the rows it is rebuilt with.
    if (!container || container.__presetRovingBound) return;
    container.__presetRovingBound = true;

    // Arrow keys are not the only way focus lands on an item: a mouse click, a
    // Tab from outside, or a programmatic focus() all bypass them. Without this
    // the roving key keeps pointing at wherever the keyboard last was, so the
    // next Up/Down jumps away from the row the user just clicked.
    container.addEventListener("focusin", (event) => {
        syncPresetRovingToFocus(container, event.target);
    });

    container.addEventListener("keydown", (event) => {
        // Leave shortcuts alone, and never swallow Enter or Space: row
        // selection and the header collapse buttons still own those.
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

        let handled = true;
        switch (event.key) {
            case "ArrowDown":
                movePresetRovingFocus(container, 1);
                break;
            case "ArrowUp":
                movePresetRovingFocus(container, -1);
                break;
            case "Home":
                movePresetRovingFocus(container, 0, "first");
                break;
            case "End":
                movePresetRovingFocus(container, 0, "last");
                break;
            default:
                handled = false;
        }

        if (handled) {
            // Otherwise Up/Down scroll the list out from under the focus.
            event.preventDefault();
        }
    });
}
