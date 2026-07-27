// Covers the theme registry, the data-theme root attribute, the color-scheme
// hint, and the sidebar theme menu's rendering and keyboard behaviour.
//
// The menu is driven against a DOM stub rather than a browser, so it covers
// focus sequence, aria bookkeeping and open/close state. Actual rendering and
// true tab order are the Playwright smoke test's job.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "theme-ui.js"), "utf8");

function makeDom() {
    const state = { focused: null };

    function makeElement(tagName = "div", id = "") {
        const classNames = new Set();
        const attributes = new Map();
        const el = {
            tagName,
            id,
            dataset: {},
            style: {},
            children: [],
            parent: null,
            hidden: false,
            tabIndex: 0,
            type: "",
            innerHTML: "",
            listeners: {},
            get className() {
                return Array.from(classNames).join(" ");
            },
            set className(value) {
                classNames.clear();
                String(value).split(" ").filter(Boolean).forEach(n => classNames.add(n));
            },
            classList: {
                add: name => classNames.add(name),
                remove: name => classNames.delete(name),
                contains: name => classNames.has(name),
                toggle(name, force) {
                    const add = force === undefined ? !classNames.has(name) : Boolean(force);
                    if (add) classNames.add(name);
                    else classNames.delete(name);
                    return add;
                },
            },
            setAttribute: (name, value) => attributes.set(name, String(value)),
            getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
            appendChild(child) {
                child.parent = this;
                this.children.push(child);
                return child;
            },
            get textContent() {
                return this._text || "";
            },
            set textContent(value) {
                this._text = String(value);
                // Assigning textContent replaces children, which is how
                // renderMenu() clears the list before rebuilding it.
                if (value === "") this.children = [];
            },
            focus() {
                state.focused = this;
            },
            closest(selector) {
                const wanted = selector.replace(/^\./, "");
                let node = this;
                while (node) {
                    if (node.classList.contains(wanted)) return node;
                    node = node.parent;
                }
                return null;
            },
            addEventListener(name, handler) {
                (this.listeners[name] = this.listeners[name] || []).push(handler);
            },
            querySelectorAll(selector) {
                const found = [];
                const walk = node => {
                    for (const child of node.children) {
                        if (matches(child, selector)) found.push(child);
                        walk(child);
                    }
                };
                walk(this);
                return found;
            },
        };
        return el;
    }

    function matches(node, selector) {
        if (selector === "[data-theme-option]") return node.dataset.themeOption !== undefined;
        if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
        return false;
    }

    const root = makeElement("body");
    const byId = new Map();
    function register(el) {
        byId.set(el.id, el);
        return el;
    }

    const menu = register(makeElement("div", "theme-menu"));
    menu.className = "theme-menu";
    const trigger = register(makeElement("button", "theme-menu-trigger"));
    trigger.setAttribute("aria-expanded", "false");
    const currentLabel = register(makeElement("span", "theme-menu-current"));
    const currentSwatch = register(makeElement("span", "theme-menu-current-swatch"));
    const list = register(makeElement("ul", "theme-menu-list"));
    list.hidden = true;

    menu.appendChild(trigger);
    trigger.appendChild(currentSwatch);
    trigger.appendChild(currentLabel);
    menu.appendChild(list);
    root.appendChild(menu);

    const meta = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const documentElement = { dataset: {} };

    const document = {
        documentElement,
        listeners: {},
        createElement: tagName => makeElement(tagName),
        getElementById: id => byId.get(id) || null,
        querySelector: selector => (selector === 'meta[name="color-scheme"]' ? meta : null),
        querySelectorAll: selector => root.querySelectorAll(selector),
        addEventListener(name, handler) {
            (this.listeners[name] = this.listeners[name] || []).push(handler);
        },
    };

    return { state, document, documentElement, meta, root, menu, trigger, list, currentLabel, currentSwatch };
}

function fire(el, type, event = {}) {
    const handlers = el.listeners[type] || [];
    const payload = Object.assign({ preventDefault() {}, target: el }, event);
    for (const handler of handlers) handler(payload);
}

function run(storedTheme) {
    const dom = makeDom();
    const storage = new Map();
    if (storedTheme !== undefined) storage.set("llama_gui_theme", storedTheme);

    const context = {
        window: {},
        console,
        document: dom.document,
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, value),
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "ui/js/theme-ui.js" });

    const themeUi = context.window.LlamaGui.themeUi;
    return Object.assign({}, dom, {
        context,
        themeUi,
        storage,
        items: () => dom.list.querySelectorAll("[data-theme-option]"),
    });
}

{
    // The default theme sets its attribute like any other; it is not "the
    // absent case" any more.
    const t = run(undefined);
    t.themeUi.init();

    assert.equal(t.documentElement.dataset.theme, "tokyo");
    assert.equal(t.meta.attributes.content, "dark light");

    const items = t.items();
    assert.equal(items[0].getAttribute("aria-checked"), "true");
    assert.equal(items[1].getAttribute("aria-checked"), "false");
    assert.equal(items[0].tabIndex, 0, "checked row is the menu's single tab stop");
    assert.equal(items[1].tabIndex, -1);
}

{
    const t = run("cappuccino");
    t.themeUi.init();

    assert.equal(t.documentElement.dataset.theme, "cappuccino");
    assert.equal(t.meta.attributes.content, "light dark");
    assert.equal(t.currentLabel.textContent, "Cappuccino", "trigger names the active theme");
    assert.ok(t.currentSwatch.style.background.includes("#fff4e6"), "trigger swatch tracks the theme");
}

{
    // An unrecognised stored theme normalises to the default rather than
    // being written through to the attribute.
    const t = run("no-such-theme");
    t.themeUi.init();
    assert.equal(t.documentElement.dataset.theme, "tokyo");
}

{
    // The menu is built from the registry, so a new theme needs no markup.
    const t = run(undefined);
    t.themeUi.init();

    const themes = t.themeUi.getThemes();
    const items = t.items();
    assert.equal(items.length, themes.length, "one row per registry entry");
    items.forEach((item, i) => {
        const theme = themes[i];
        assert.equal(item.dataset.themeOption, theme.id);
        assert.equal(item.getAttribute("role"), "menuitemradio");
        assert.equal(item.parent.getAttribute("role"), "none", "<li> must not be a listitem inside role=menu");

        const [swatch, label, hint] = item.children;
        assert.ok(swatch.style.background.includes(theme.swatchBg), `${theme.id} swatch uses its own colors`);
        assert.equal(label.textContent, theme.label);
        assert.equal(hint.textContent, theme.hint);
    });
}

{
    // The color-scheme hint is driven by the registry, not by a hardcoded
    // theme name. This is the regression the registry exists to prevent: a
    // new light theme that keeps reporting "dark light" makes the browser
    // style native controls and scrollbars for the wrong polarity.
    const t = run(undefined);
    const themes = t.themeUi.getThemes();

    assert.ok(themes.length >= 2, "registry should list every shipped theme");
    for (const theme of themes) {
        assert.ok(theme.id && theme.label, `theme ${theme.id} needs an id and label`);
        assert.ok(
            theme.scheme === "light" || theme.scheme === "dark",
            `theme ${theme.id} needs an explicit light/dark scheme`
        );
        t.themeUi.applyTheme(theme.id);
        assert.equal(
            t.meta.attributes.content,
            theme.scheme === "light" ? "light dark" : "dark light",
            `theme ${theme.id} reported the wrong color-scheme hint`
        );
    }
}

{
    // Opening puts focus on the checked row, not blindly on the first.
    const t = run("cappuccino");
    t.themeUi.init();

    fire(t.trigger, "click");
    assert.equal(t.trigger.getAttribute("aria-expanded"), "true");
    assert.equal(t.list.hidden, false);
    assert.equal(t.state.focused.dataset.themeOption, "cappuccino");
}

{
    // Arrow keys wrap in both directions; Home/End jump to the ends.
    const t = run(undefined);
    t.themeUi.init();
    const items = t.items();
    const last = items.length - 1;

    fire(t.trigger, "click");
    assert.equal(t.state.focused, items[0]);

    fire(items[0], "keydown", { key: "ArrowDown" });
    assert.equal(t.state.focused, items[1]);

    fire(items[0], "keydown", { key: "ArrowUp" });
    assert.equal(t.state.focused, items[last], "Up from the first row wraps to the last");

    fire(items[last], "keydown", { key: "ArrowDown" });
    assert.equal(t.state.focused, items[0], "Down from the last row wraps to the first");

    fire(items[0], "keydown", { key: "End" });
    assert.equal(t.state.focused, items[last]);

    fire(items[last], "keydown", { key: "Home" });
    assert.equal(t.state.focused, items[0]);
}

{
    // Escape closes and hands focus back to the trigger, rather than
    // stranding it inside a hidden menu.
    const t = run(undefined);
    t.themeUi.init();
    const items = t.items();

    fire(t.trigger, "click");
    fire(items[0], "keydown", { key: "Escape" });

    assert.equal(t.trigger.getAttribute("aria-expanded"), "false");
    assert.equal(t.list.hidden, true);
    assert.equal(t.state.focused, t.trigger);
}

{
    // ArrowDown on a closed trigger opens the menu.
    const t = run(undefined);
    t.themeUi.init();

    fire(t.trigger, "keydown", { key: "ArrowDown" });
    assert.equal(t.trigger.getAttribute("aria-expanded"), "true");
}

{
    // Choosing a row applies and persists the theme, closes the menu, and
    // returns focus to the trigger.
    const t = run(undefined);
    t.themeUi.init();
    const items = t.items();

    fire(t.trigger, "click");
    fire(items[1], "click");

    assert.equal(t.documentElement.dataset.theme, "cappuccino");
    assert.equal(t.storage.get("llama_gui_theme"), "cappuccino");
    assert.equal(items[1].getAttribute("aria-checked"), "true");
    assert.equal(items[0].getAttribute("aria-checked"), "false");
    assert.equal(t.list.hidden, true);
    assert.equal(t.state.focused, t.trigger);
    assert.equal(t.currentLabel.textContent, "Cappuccino");
}

{
    // A click outside the menu closes it; a click inside does not.
    const t = run(undefined);
    t.themeUi.init();

    fire(t.trigger, "click");
    const outside = { closest: () => null };
    t.document.listeners.click.forEach(h => h({ target: outside }));
    assert.equal(t.list.hidden, true, "outside click closes");

    fire(t.trigger, "click");
    t.document.listeners.click.forEach(h => h({ target: t.items()[0] }));
    assert.equal(t.list.hidden, false, "click inside the menu leaves it open");
}

console.log("theme-ui unit checks passed");
