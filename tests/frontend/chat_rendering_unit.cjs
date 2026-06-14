const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-rendering.js"), "utf8");

function createClassList(el) {
    return {
        add: (...names) => {
            for (const name of names) el._classes.add(name);
            el.className = Array.from(el._classes).join(" ");
        },
        remove: (...names) => {
            for (const name of names) el._classes.delete(name);
            el.className = Array.from(el._classes).join(" ");
        },
        contains: (name) => el._classes.has(name),
        toggle: (name, force) => {
            const shouldAdd = force === undefined ? !el._classes.has(name) : !!force;
            if (shouldAdd) el._classes.add(name);
            else el._classes.delete(name);
            el.className = Array.from(el._classes).join(" ");
            return shouldAdd;
        },
    };
}

function createElement(tagName) {
    const el = {
        tagName: tagName.toUpperCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        _classes: new Set(),
        _className: "",
        _textContent: "",
        _innerHTML: "",
        href: "",
        target: "",
        rel: "",
        title: "",
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        remove() {
            if (!this.parentNode) return;
            this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
            this.parentNode = null;
        },
        closest(selector) {
            if (!selector.startsWith(".")) return null;
            const className = selector.slice(1);
            let node = this;
            while (node) {
                if (node._classes && node._classes.has(className)) return node;
                node = node.parentNode;
            }
            return null;
        },
        querySelector(selector) {
            if (!selector.startsWith(".")) return null;
            const className = selector.slice(1);
            const stack = [...this.children];
            while (stack.length) {
                const child = stack.shift();
                if (child._classes && child._classes.has(className)) return child;
                stack.push(...child.children);
            }
            return null;
        },
    };
    Object.defineProperty(el, "className", {
        get() {
            return this._className;
        },
        set(value) {
            this._className = String(value || "");
            this._classes = new Set(this._className.split(/\s+/).filter(Boolean));
        },
    });
    Object.defineProperty(el, "textContent", {
        get() {
            return this._textContent;
        },
        set(value) {
            this._textContent = String(value || "");
        },
    });
    Object.defineProperty(el, "innerHTML", {
        get() {
            return this._innerHTML;
        },
        set(value) {
            this._innerHTML = String(value || "");
        },
    });
    el.classList = createClassList(el);
    return el;
}

const elements = new Map();
const context = {
    window: { LlamaGui: {} },
    document: {
        createElement,
        getElementById: (id) => elements.get(id) || null,
    },
    URL,
    console,
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/chat-rendering.js" });

const rendering = context.window.LlamaGui.chatRendering;

{
    const html = rendering.renderMarkdown([
        "# <img src=x onerror=alert(1)> **safe**",
        "",
        "- <script>alert(1)</script>",
        "1. `</code><img src=x>`",
        "",
        "| <b>h</b> | value |",
        "| --- | --- |",
        "| <i>x</i> | ~~gone~~ |",
        "",
        "Plain <svg onload=alert(1)> text",
    ].join("\n"));

    assert.ok(!html.includes("<img"), "chat markdown should not emit raw image HTML");
    assert.ok(!html.includes("<script"), "chat markdown should not emit raw script HTML");
    assert.ok(!html.includes("<svg"), "chat markdown should not emit raw svg HTML");
    assert.match(html, /<h1>&lt;img src=x onerror=alert\(1\)&gt; <strong>safe<\/strong><\/h1>/);
    assert.match(html, /<li>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/);
    assert.match(html, /<code>&lt;\/code&gt;&lt;img src=x&gt;<\/code>/);
    assert.match(html, /<th>&lt;b&gt;h&lt;\/b&gt;<\/th>/);
    assert.match(html, /<td>&lt;i&gt;x&lt;\/i&gt;<\/td>/);
    assert.match(html, /Plain &lt;svg onload=alert\(1\)&gt; text<\/p>/);
}

{
    const html = rendering.renderMarkdown("```html\n<div onclick=\"bad()\">x</div>\n```");

    assert.match(html, /<pre data-lang="html"><code>&lt;div onclick=&quot;bad\(\)&quot;&gt;x&lt;\/div&gt;<\/code><\/pre>/);
    assert.ok(!html.includes("<div onclick"), "fenced code blocks should stay escaped");
}

{
    const wrap = createElement("div");
    wrap.className = "chat-message-content";
    const bubble = createElement("div");
    bubble.className = "chat-bubble";
    wrap.appendChild(bubble);

    rendering.renderChatSources(bubble, [
        { index: 1, title: "JS URL", url: "javascript:alert(1)" },
        { index: 2, title: "HTTP URL", url: "http://example.com/path" },
        { index: 3, title: "HTTPS URL", url: "https://example.com/secure" },
        { index: 4, title: "File URL", url: "file:///etc/passwd" },
    ]);

    const sources = wrap.querySelector(".chat-sources");
    assert.ok(sources, "expected chat sources wrapper");
    assert.equal(sources.children[0].tagName, "SPAN");
    assert.equal(sources.children[0].href, "");
    assert.equal(sources.children[1].tagName, "A");
    assert.equal(sources.children[1].href, "http://example.com/path");
    assert.equal(sources.children[2].tagName, "A");
    assert.equal(sources.children[2].href, "https://example.com/secure");
    assert.equal(sources.children[3].tagName, "SPAN");
}

console.log("chat rendering unit tests passed");
