// Shared frontend test helper: parses the canonical ordered script list from
// ui/index.html so VM harnesses and contract tests read one source of truth
// instead of duplicating hard-coded package file lists.
//
// `ui/index.html` is the canonical frontend load order (see docs/directory.md);
// when scripts are added or reordered there, every consumer of this helper
// follows automatically.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..", "..");
const UI_DIR = path.join(ROOT, "ui");
const INDEX_HTML_PATH = path.join(UI_DIR, "index.html");

function readIndexHtml() {
    return fs.readFileSync(INDEX_HTML_PATH, "utf8");
}

// "/js/app.js?v=revamp-4#frag" -> "js/app.js" (path relative to ui/).
function normalizeSrc(src) {
    return src.replace(/^\//, "").split("?")[0].split("#")[0];
}

// Every active <script> tag in load order, including its execution attributes.
// src is the raw attribute value or null for inline scripts. Unlike a
// `src="/js/..."`-only regex, this sees tags with extra attributes or
// unusual spacing too, so contract tests can fail loudly instead of
// silently skipping a script.
function listScriptTags(html = readIndexHtml()) {
    const tags = [];
    // Consume comments as whole tokens, without stripping comment-like text
    // inside a script body. Quoted attribute values may contain > characters.
    const tagRe = /<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script\s*>/gi;
    let match;
    while ((match = tagRe.exec(html)) !== null) {
        if (match[1] === undefined) continue; // HTML comment
        const attrs = new Map();
        const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        for (const attr of match[1].matchAll(attrRe)) {
            const name = attr[1].toLowerCase();
            if (!attrs.has(name)) attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? "");
        }
        const src = attrs.get("src") ?? null;
        const external = src !== null && /^(?:https?:|data:|\/\/)/i.test(src);
        tags.push({
            src, external, inline: src === null,
            async: attrs.has("async"),
            defer: attrs.has("defer"),
            nomodule: attrs.has("nomodule"),
            type: (attrs.get("type") ?? "").trim().toLowerCase(),
        });
    }
    return tags;
}

// Ordered script paths, relative to ui/, exactly as referenced by
// ui/index.html (local scripts only, cache-buster queries stripped).
function getScriptPaths(html = readIndexHtml()) {
    return listScriptTags(html)
        .filter((tag) => tag.src !== null && !tag.external)
        .map((tag) => {
            assert.ok(
                !tag.async && !tag.defer && !tag.nomodule
                    && ["", "text/javascript", "application/javascript"].includes(tag.type),
                `script "${tag.src}" must use blocking classic-script execution ` +
                    "(no async, defer, nomodule, or unsupported type)"
            );
            return normalizeSrc(tag.src);
        });
}

// Scripts of one directory package, e.g. getPackagePaths("js/presets").
function getPackagePaths(prefix, html = readIndexHtml()) {
    const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return getScriptPaths(html).filter((src) => src.startsWith(`${dir}/`));
}

function getPackageFileNames(prefix, html = readIndexHtml()) {
    return getPackagePaths(prefix, html).map((src) => src.slice(src.lastIndexOf("/") + 1));
}

// Ordered { fileName, path, uiPath, source } entries for a package — the
// shape VM harnesses need to evaluate a package file-by-file, mirroring the
// browser's script boundaries.
function getPackageScripts(prefix, html = readIndexHtml()) {
    return getPackagePaths(prefix, html).map((src) => ({
        fileName: src.slice(src.lastIndexOf("/") + 1),
        path: src,
        uiPath: `ui/${src}`,
        source: fs.readFileSync(path.join(UI_DIR, src), "utf8"),
    }));
}

module.exports = {
    ROOT,
    UI_DIR,
    INDEX_HTML_PATH,
    readIndexHtml,
    normalizeSrc,
    listScriptTags,
    getScriptPaths,
    getPackagePaths,
    getPackageFileNames,
    getPackageScripts,
};
