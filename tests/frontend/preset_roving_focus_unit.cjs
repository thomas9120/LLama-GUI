// Covers the roving arrow-key focus in the presets browser list.
//
// The list is one composite widget: 33 group headers plus 58 rows, each row
// carrying a checkbox, a favorite toggle, and a Load button, is 265 tab stops
// to cross a real library. Roving tabindex reduces that to one stop into the
// list plus the focused row's own controls.
//
// These tests drive the real traversal against a DOM stub rather than a browser,
// so they cover sequence, skipping, and tabindex bookkeeping. The visual result
// and true Tab order are the Playwright smoke test's job.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "presets.js"), "utf8");

function makeElement(className = "") {
    const classNames = new Set(String(className).split(" ").filter(Boolean));
    const attributes = new Map();
    const el = {
        children: [],
        tabIndex: 0,
        focused: false,
        get className() {
            return Array.from(classNames).join(" ");
        },
        classList: {
            add: (name) => classNames.add(name),
            remove: (name) => classNames.delete(name),
            contains: (name) => classNames.has(name),
            toggle: (name, force) => {
                const add = force === undefined ? !classNames.has(name) : Boolean(force);
                if (add) classNames.add(name);
                else classNames.delete(name);
                return add;
            },
        },
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        focus() {
            this.focused = true;
        },
        // Depth-first walk, matching document order, over the tiny selector
        // vocabulary the roving code actually uses.
        querySelectorAll(selector) {
            const wanted = selector.split(",").map((s) => s.trim());
            const found = [];
            const matches = (node) => wanted.some((sel) => (
                sel.startsWith(".")
                    ? node.classList.contains(sel.slice(1))
                    : node.tagName === sel
            ));
            const walk = (node) => {
                for (const child of node.children) {
                    if (matches(child)) found.push(child);
                    walk(child);
                }
            };
            walk(this);
            return found;
        },
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        },
    };
    return el;
}

// Builds a list shaped like the real render: groups, each with a header button
// and rows, each row carrying its three inner controls.
function buildList(groups) {
    const container = makeElement();
    container.__listeners = {};
    container.addEventListener = (type, handler) => {
        container.__listeners[type] = handler;
    };
    container.contains = () => false;

    for (const group of groups) {
        const groupEl = makeElement("preset-group");
        if (group.collapsed) groupEl.classList.add("collapsed");

        const header = makeElement("preset-group-header");
        header.tagName = "button";
        header.setAttribute("data-group-key", group.key);
        groupEl.appendChild(header);

        const list = makeElement("preset-group-list");
        for (const name of group.rows) {
            const row = makeElement("preset-item");
            row.setAttribute("data-preset-name", name);
            const checkbox = makeElement();
            checkbox.tagName = "input";
            const favorite = makeElement("preset-row-favorite");
            favorite.tagName = "button";
            const load = makeElement("preset-row-load");
            load.tagName = "button";
            row.appendChild(checkbox);
            row.appendChild(favorite);
            row.appendChild(load);
            list.appendChild(row);
        }
        groupEl.appendChild(list);
        container.appendChild(groupEl);
    }
    return container;
}

function createContext() {
    const ctx = {
        window: {},
        document: { getElementById: () => null, activeElement: null, body: {} },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: { getItem: () => null, setItem: () => {} },
        FLAGS: [],
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = { manager: { getKnownModelNames: () => null } };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    return ctx;
}

const ctx = createContext();
const api = ctx.window.LlamaGui.presets;
const keyOf = (el) => el.getAttribute("data-preset-name") || `#${el.getAttribute("data-group-key")}`;

// getPresetFocusItems returns an array built inside the vm realm, and .map on it
// yields another one. assert/strict compares prototypes, so an identical-looking
// result still fails unless it is copied into this realm first. Same realm trap
// as the instanceof note in AGENTS.md, wearing a different hat.
const focusKeys = (container) => Array.from(api.getPresetFocusItems(container)).map(keyOf);

// --- Sequence ---------------------------------------------------------------
const list = buildList([
    { key: "a.gguf", rows: ["alpha", "beta"] },
    { key: "b.gguf", rows: ["gamma"] },
]);
assert.deepEqual(
    focusKeys(list),
    ["#a.gguf", "alpha", "beta", "#b.gguf", "gamma"],
    "the sequence is headers and rows interleaved in document order"
);

// --- Collapsed groups are skipped -------------------------------------------
const withCollapsed = buildList([
    { key: "a.gguf", rows: ["alpha", "beta"], collapsed: true },
    { key: "b.gguf", rows: ["gamma"] },
]);
assert.deepEqual(
    focusKeys(withCollapsed),
    ["#a.gguf", "#b.gguf", "gamma"],
    "rows in a collapsed group are display:none and must not be focus targets"
);

// --- Tabindex bookkeeping ---------------------------------------------------
// This is the whole point of the change: everything except the current item
// leaves the tab order, including each row's three inner controls.
vm.runInContext("presetRovingKey = ''; selectedPresetName = ''", ctx);
const current = api.applyPresetRovingTabIndex(list);
assert.equal(keyOf(current), "#a.gguf", "with no prior state the first item takes focus");

const items = Array.from(api.getPresetFocusItems(list));
assert.equal(items.filter((el) => el.tabIndex === 0).length, 1, "exactly one item is tab-reachable");
assert.equal(items[0].tabIndex, 0);
assert.ok(items.slice(1).every((el) => el.tabIndex === -1), "every other item is removed from the tab order");

const firstRow = items[1];
assert.ok(
    firstRow.querySelectorAll("input, button").every((el) => el.tabIndex === -1),
    "a non-current row's checkbox, favorite, and Load button all leave the tab order"
);

// The current row's controls come back, so Tab still reaches them then exits.
vm.runInContext("presetRovingKey = 'row:alpha'", ctx);
api.applyPresetRovingTabIndex(list);
assert.equal(firstRow.tabIndex, 0, "the current row is tab-reachable");
assert.ok(
    firstRow.querySelectorAll("input, button").every((el) => el.tabIndex === 0),
    "and its own controls ride back into the tab order with it"
);

// --- Movement ---------------------------------------------------------------
const moved = (setup, delta, absolute) => {
    vm.runInContext(`presetRovingKey = ${JSON.stringify(setup)}`, ctx);
    ctx.__list = list;
    vm.runInContext(
        `movePresetRovingFocus(__list, ${delta}, ${JSON.stringify(absolute || "")})`,
        ctx
    );
    return vm.runInContext("presetRovingKey", ctx);
};

assert.equal(moved("group:a.gguf", 1), "row:alpha", "Down moves from a header into its first row");
assert.equal(moved("row:beta", 1), "group:b.gguf", "Down crosses from the last row into the next header");
assert.equal(moved("row:alpha", -1), "group:a.gguf", "Up moves back out to the header");
assert.equal(moved("group:a.gguf", -1), "group:a.gguf", "Up at the top clamps rather than wrapping");
assert.equal(moved("row:gamma", 1), "row:gamma", "Down at the bottom clamps rather than wrapping");
assert.equal(moved("row:beta", 0, "first"), "group:a.gguf", "Home jumps to the first item");
assert.equal(moved("group:a.gguf", 0, "last"), "row:gamma", "End jumps to the last item");

// Movement focuses the new item, not just the bookkeeping.
const focusList = buildList([{ key: "a.gguf", rows: ["alpha", "beta"] }]);
ctx.__focusList = focusList;
vm.runInContext("presetRovingKey = 'group:a.gguf'; movePresetRovingFocus(__focusList, 1)", ctx);
const focusItems = Array.from(api.getPresetFocusItems(focusList));
assert.equal(focusItems[1].focused, true, "arrowing to an item moves real focus to it");

// --- Survives a re-render ---------------------------------------------------
// Selecting or favoriting rebuilds every row. The key is matched by identity,
// so focus lands back on the same preset rather than resetting to the top.
vm.runInContext("presetRovingKey = 'row:gamma'", ctx);
const rebuilt = buildList([
    { key: "a.gguf", rows: ["alpha", "beta"] },
    { key: "b.gguf", rows: ["gamma"] },
]);
assert.equal(
    keyOf(api.applyPresetRovingTabIndex(rebuilt)),
    "gamma",
    "a rebuilt list restores the roving position by preset name"
);

// A preset filtered out of the list must not strand focus.
vm.runInContext("presetRovingKey = 'row:vanished'; selectedPresetName = ''", ctx);
assert.equal(
    keyOf(api.applyPresetRovingTabIndex(rebuilt)),
    "#a.gguf",
    "a roving key that no longer exists falls back to the first item"
);

// With a selection present, focus starts there rather than at the top.
vm.runInContext("presetRovingKey = 'row:vanished'; selectedPresetName = 'beta'", ctx);
assert.equal(
    keyOf(api.applyPresetRovingTabIndex(rebuilt)),
    "beta",
    "the selected preset is preferred over the top of the library"
);

// --- Focus arriving by other routes -----------------------------------------
// Arrow keys are not the only way an item gets focus. A mouse click, a Tab from
// outside, or a programmatic focus() all bypass movePresetRovingFocus, and
// without a focusin sync the roving key would keep pointing at wherever the
// keyboard last was — so the next Up/Down would jump away from the row the user
// just clicked.
const syncList = buildList([
    { key: "a.gguf", rows: ["alpha", "beta"] },
    { key: "b.gguf", rows: ["gamma"] },
]);
ctx.__syncList = syncList;
vm.runInContext("initPresetRovingFocus(__syncList); presetRovingKey = 'row:alpha'", ctx);
const syncItems = Array.from(api.getPresetFocusItems(syncList));
const gammaRow = syncItems.find((el) => el.getAttribute("data-preset-name") === "gamma");

syncList.__listeners.focusin({ target: gammaRow });
assert.equal(
    vm.runInContext("presetRovingKey", ctx),
    "row:gamma",
    "focus landing on a row must move the roving position to it"
);
assert.equal(gammaRow.tabIndex, 0, "and that row becomes the tab-reachable one");

// Focus landing on a control inside a row counts as focusing the row.
gammaRow.contains = (node) => gammaRow.querySelectorAll("input, button").includes(node);
vm.runInContext("presetRovingKey = 'row:alpha'", ctx);
const loadButton = gammaRow.querySelectorAll("input, button")[2];
syncList.__listeners.focusin({ target: loadButton });
assert.equal(
    vm.runInContext("presetRovingKey", ctx),
    "row:gamma",
    "focusing a row's Load button must count as focusing the row"
);

// Focus outside the sequence must leave the roving position alone.
vm.runInContext("presetRovingKey = 'row:alpha'", ctx);
syncList.__listeners.focusin({ target: makeElement("something-else") });
assert.equal(
    vm.runInContext("presetRovingKey", ctx),
    "row:alpha",
    "focus on something that is not a list item must not move the roving position"
);

// --- Empty list -------------------------------------------------------------
const empty = buildList([]);
assert.deepEqual(Array.from(api.getPresetFocusItems(empty)), [], "an empty list has no focus targets");
assert.equal(api.applyPresetRovingTabIndex(empty), null, "and applying roving state is a safe no-op");

console.log("preset roving focus unit tests passed");
