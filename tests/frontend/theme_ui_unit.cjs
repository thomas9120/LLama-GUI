const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "theme-ui.js"), "utf8");

function makeButton(theme) {
    return {
        dataset: { themeOption: theme },
        classes: new Set(),
        attributes: {},
        listeners: {},
        classList: {
            toggle(name, active) {
                if (active) {
                    this.owner.classes.add(name);
                } else {
                    this.owner.classes.delete(name);
                }
            },
        },
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        addEventListener(name, handler) {
            this.listeners[name] = handler;
        },
    };
}

function runWithStoredTheme(storedTheme) {
    const buttons = [makeButton("tokyo"), makeButton("cappuccino")];
    for (const button of buttons) {
        button.classList.owner = button;
    }

    const storage = new Map();
    if (storedTheme !== undefined) storage.set("llama_gui_theme", storedTheme);

    const meta = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const documentElement = {
        dataset: {},
        removeAttribute(name) {
            if (name === "data-theme") delete this.dataset.theme;
        },
    };

    const context = {
        window: {},
        console,
        document: {
            documentElement,
            querySelector(selector) {
                return selector === 'meta[name="color-scheme"]' ? meta : null;
            },
            querySelectorAll(selector) {
                return selector === "[data-theme-option]" ? buttons : [];
            },
        },
        localStorage: {
            getItem(key) {
                return storage.has(key) ? storage.get(key) : null;
            },
            setItem(key, value) {
                storage.set(key, value);
            },
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "ui/js/theme-ui.js" });
    return { buttons, context, documentElement, meta, storage };
}

{
    // The default theme sets its attribute like any other; it is not "the
    // absent case" any more.
    const { buttons, context, documentElement, meta } = runWithStoredTheme(undefined);
    context.window.LlamaGui.themeUi.init();

    assert.equal(documentElement.dataset.theme, "tokyo");
    assert.equal(meta.attributes.content, "dark light");
    assert.equal(buttons[0].attributes["aria-pressed"], "true");
    assert.equal(buttons[1].attributes["aria-pressed"], "false");
}

{
    // An unrecognised stored theme normalises to the default rather than
    // being written through to the attribute.
    const { context, documentElement } = runWithStoredTheme("no-such-theme");
    context.window.LlamaGui.themeUi.init();

    assert.equal(documentElement.dataset.theme, "tokyo");
}

{
    // The color-scheme hint is driven by the registry, not by a hardcoded
    // theme name. This is the regression the registry exists to prevent: a
    // new light theme that keeps reporting "dark light" makes the browser
    // style native controls and scrollbars for the wrong polarity.
    const { context, meta } = runWithStoredTheme(undefined);
    const themeUi = context.window.LlamaGui.themeUi;
    const themes = themeUi.getThemes();

    assert.ok(themes.length >= 2, "registry should list every shipped theme");
    for (const theme of themes) {
        assert.ok(theme.id && theme.label, `theme ${theme.id} needs an id and label`);
        assert.ok(
            theme.scheme === "light" || theme.scheme === "dark",
            `theme ${theme.id} needs an explicit light/dark scheme`
        );
        themeUi.applyTheme(theme.id);
        assert.equal(
            meta.attributes.content,
            theme.scheme === "light" ? "light dark" : "dark light",
            `theme ${theme.id} reported the wrong color-scheme hint`
        );
    }
}

{
    const { buttons, context, documentElement, meta } = runWithStoredTheme("cappuccino");
    context.window.LlamaGui.themeUi.init();

    assert.equal(documentElement.dataset.theme, "cappuccino");
    assert.equal(meta.attributes.content, "light dark");
    assert.equal(buttons[0].attributes["aria-pressed"], "false");
    assert.equal(buttons[1].attributes["aria-pressed"], "true");
}

{
    const { buttons, context, documentElement, storage } = runWithStoredTheme(undefined);
    context.window.LlamaGui.themeUi.init();
    buttons[1].listeners.click();

    assert.equal(documentElement.dataset.theme, "cappuccino");
    assert.equal(storage.get("llama_gui_theme"), "cappuccino");
    assert.equal(buttons[1].attributes["aria-pressed"], "true");
}

console.log("theme-ui unit checks passed");
