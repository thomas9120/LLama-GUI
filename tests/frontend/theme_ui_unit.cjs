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
    // returns focus to the trigger. Addressed by id rather than index, so
    // reordering or adding registry entries does not break this.
    const t = run(undefined);
    t.themeUi.init();
    const items = t.items();
    const themes = t.themeUi.getThemes();

    const target = themes[themes.length - 1];
    const targetItem = items.find(item => item.dataset.themeOption === target.id);
    const otherItem = items.find(item => item.dataset.themeOption !== target.id);

    fire(t.trigger, "click");
    fire(targetItem, "click");

    assert.equal(t.documentElement.dataset.theme, target.id);
    assert.equal(t.storage.get("llama_gui_theme"), target.id);
    assert.equal(targetItem.getAttribute("aria-checked"), "true");
    assert.equal(otherItem.getAttribute("aria-checked"), "false");
    assert.equal(t.list.hidden, true);
    assert.equal(t.state.focused, t.trigger);
    assert.equal(t.currentLabel.textContent, target.label);
}

{
    // Every registry entry must have a palette block in tokens.css, or the
    // menu offers a theme that renders as the fallback.
    const fs = require("node:fs");
    const css = fs.readFileSync(path.join(ROOT, "ui", "css", "tokens.css"), "utf8");
    const t = run(undefined);
    for (const theme of t.themeUi.getThemes()) {
        assert.ok(
            css.includes(`[data-theme="${theme.id}"]`),
            `theme ${theme.id} is in the registry but has no palette block`
        );
    }
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

{
    // Contrast floor for semantic colors, in every theme.
    //
    // The subtle/border alphas were originally picked for how the *fill*
    // looked, and the same hue was then reused as text on top of that fill,
    // with nothing checking the pair. That shipped ten AA failures across
    // three themes at once. The chip -- not the bare surface -- is the worst
    // background these colors land on, so it is what they must be sized
    // against.
    const fs = require("node:fs");
    const css = fs.readFileSync(path.join(ROOT, "ui", "css", "tokens.css"), "utf8");

    const blockFor = (id) => {
        // Tokyo's palette is shared with the bare :root so it doubles as the
        // no-JS fallback; match either selector, and stay agnostic about line
        // endings so this does not depend on the checkout's CRLF setting.
        const selector = new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`);
        const match = selector.exec(css);
        assert.ok(match, `no palette block for ${id}`);
        const rest = css.slice(match.index);
        return rest.slice(0, rest.search(/\r?\n\}/));
    };

    const declarations = (block) => {
        const out = {};
        for (const [, k, v] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
        return out;
    };

    const toLinear = (c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = ([r, g, b]) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    const contrast = (a, b) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };
    const composite = (fg, alpha, bg) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

    // Resolves a token to [r,g,b] plus alpha, following var() indirection.
    const resolve = (name, decls) => {
        let value = decls[name];
        assert.ok(value, `token ${name} is not defined`);
        while (value.startsWith("var(")) {
            value = decls[value.slice(4, value.indexOf(")"))];
        }
        if (value.startsWith("#")) {
            const h = value.slice(1);
            return [[0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)), 1];
        }
        const parts = value.match(/rgba?\(([^)]+)\)/)[1].split(",").map(s => parseFloat(s.trim()));
        return [parts.slice(0, 3), parts.length > 3 ? parts[3] : 1];
    };

    const tokyo = declarations(blockFor("tokyo"));
    const AA = 4.5;      // WCAG 1.4.3, normal-size text
    const UI = 3.0;      // WCAG 1.4.11, non-text and non-essential text
    const families = [
        ["--accent-text", "--accent-subtle"],
        ["--green", "--green-subtle"],
        ["--red", "--red-subtle"],
        ["--yellow", "--yellow-subtle"],
        ["--favorite", "--favorite-subtle"],
    ];
    // --fg-faint is the one tier deliberately held to the 3:1 floor rather
    // than AA: raising it to 4.5 would collapse it into --fg-muted and the
    // design would lose a tier. Anything that carries meaning must not use
    // it -- placeholders were moved off it for exactly this reason.
    const neutrals = [["--fg", AA], ["--fg-muted", AA], ["--fg-faint", UI]];
    // These are fills only, so 3:1 is the right floor. The assertion below
    // that they are never used as `color:` is what keeps that true.
    const solids = ["--yellow-solid", "--favorite-solid"];

    const failures = [];
    const t = run(undefined);
    for (const theme of t.themeUi.getThemes()) {
        const decls = Object.assign({}, tokyo, declarations(blockFor(theme.id)));
        const surface = resolve("--bg-surface", decls)[0];
        // Text lands on all three of these, not just the surface: raised for
        // panels and list rows, elevated for dropdowns and .badge-dim.
        const backgrounds = [
            ["surface", surface],
            ["bg-raised", resolve("--bg-raised", decls)[0]],
            ["bg-elevated", resolve("--bg-elevated", decls)[0]],
        ];

        const check = (token, floor, extra = []) => {
            const fg = resolve(token, decls)[0];
            for (const [label, bg] of backgrounds.concat(extra)) {
                const ratio = contrast(fg, bg);
                if (ratio < floor) {
                    failures.push(`${theme.id} ${token} on ${label}: ${ratio.toFixed(2)} (need ${floor})`);
                }
            }
        };

        for (const [token, floor] of neutrals) check(token, floor);
        for (const [text, subtle] of families) {
            const [subRgb, subAlpha] = resolve(subtle, decls);
            check(text, AA, [["own chip", composite(subRgb, subAlpha, surface)]]);
        }

        // --red-fg exists only to be read on a --red-subtle fill, so the chip
        // is the only background that matters for it.
        {
            const [subRgb, subAlpha] = resolve("--red-subtle", decls);
            const chip = composite(subRgb, subAlpha, surface);
            const ratio = contrast(resolve("--red-fg", decls)[0], chip);
            if (ratio < AA) {
                failures.push(`${theme.id} --red-fg on red-subtle chip: ${ratio.toFixed(2)} (need ${AA})`);
            }
        }
        // Fills, and only ever drawn inside the Presets browser, which sits on
        // --panel-wash and row backgrounds -- never on an elevated surface.
        for (const token of solids) {
            const fg = resolve(token, decls)[0];
            for (const [label, bg] of backgrounds.slice(0, 2)) {
                const ratio = contrast(fg, bg);
                if (ratio < UI) failures.push(`${theme.id} ${token} on ${label}: ${ratio.toFixed(2)} (need ${UI})`);
            }
        }
    }
    assert.deepEqual(failures, [], `contrast floors violated:\n  ${failures.join("\n  ")}`);
}

{
    // The -solid tokens are held to 3:1, not 4.5:1, because they are fills.
    // If one ever becomes a text color that floor is wrong, so pin the
    // invariant rather than trusting it.
    const fs = require("node:fs");
    const style = fs.readFileSync(path.join(ROOT, "ui", "css", "style.css"), "utf8");
    for (const token of ["--yellow-solid", "--favorite-solid"]) {
        const asText = new RegExp(`(^|[^-\\w])color:\\s*var\\(${token}\\)`, "m");
        assert.ok(
            !asText.test(style),
            `${token} is a fill token held to the 3:1 floor and must not be used as a text color`
        );
    }

    // --fg-faint is the only text tier below AA, so it is reserved for
    // genuinely non-essential text and decorative fills. Placeholders are
    // content -- WCAG 1.4.3 applies to them -- so they must sit on a tier
    // that clears AA.
    const placeholders = style
        .split(/\r?\n/)
        .filter(line => /::placeholder|\.ss-placeholder/.test(line) && line.includes("--fg-faint"));
    assert.deepEqual(
        placeholders, [],
        `placeholder text must not use --fg-faint (below AA):\n  ${placeholders.join("\n  ")}`
    );
}

console.log("theme-ui unit checks passed");
