const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const { test } = require("node:test");
const { startUiServer } = require("./ui_server.cjs");

const { chromium } = (() => {
    try {
        return require("playwright");
    } catch (error) {
        throw new Error("Chat pop-out integration requires the dev-only playwright package. Run npm ci first.");
    }
})();

const ROOT = path.resolve(__dirname, "..", "..");
const UI_ROOT = path.join(ROOT, "ui");
const POPUP_QUERY = "chat-window=1";
const CHAT_POP_OUT = "#btn-chat-popout";
const CHAT_WINDOW_PLACEHOLDER = "#chat-window-placeholder";
const CHAT_SHOW_WINDOW = "#btn-chat-show-window";
const CHAT_RETURN_HERE = "#btn-chat-return-here";
const CHAT_RETURN = "#btn-chat-return";
const CHAT_HOST_STATUS = "#chat-window-host-status";
const CHAT_OPEN_FULL_GUI = "#chat-window-open-full-gui";
const API_SECRET = "fixture-api-secret-must-not-persist";

test("browser launch failure closes the fixture server", { timeout: 15_000 }, () => {
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(os.tmpdir(), randomUUID()) };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
        "--test", "--test-name-pattern=^direct Chat window URL", __filename,
    ], {
        env,
        encoding: "utf8",
        timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, "missing Chromium must fail promptly rather than hang");
    assert.match(result.stdout + result.stderr, /Executable doesn't exist/);
});

function json(value) {
    return JSON.stringify(value);
}

function representativeConversation() {
    return {
        id: "phase3-fixture-conversation",
        title: "Phase 3 fixture conversation",
        titleCustom: true,
        systemPrompt: "Fixture system prompt survives the detached window.",
        thinkingEffort: "high",
        messages: [
            {
                role: "user",
                content: "Retain this complete representative fixture.",
                metadata: { prompt_tokens: 11, timings: { prompt_ms: 3.5 } },
            },
            {
                role: "assistant",
                content: "Stored answer selected for the pop-out.",
                reasoning: "Stored reasoning survives the transfer.",
                sources: [{ title: "Fixture source", url: "https://example.test/source" }],
                status: "complete",
                metadata: { stop_reason: "stop", usage: { prompt_tokens: 11, completion_tokens: 9 } },
                toolMessages: [{ role: "tool", content: "Fixture tool result", tool_call_id: "tool-1", name: "fixture" }],
                versions: [
                    { content: "Stored answer selected for the pop-out.", reasoning: "Stored reasoning survives the transfer.", status: "complete" },
                    { content: "Unused alternate answer.", status: "stopped", error: "fixture alternate" },
                ],
                versionIndex: 0,
            },
            { role: "user", content: "Second fixture turn." },
            { role: "assistant", content: "Second fixture answer." },
            { role: "user", content: "Third fixture turn." },
            { role: "assistant", content: "Third fixture answer." },
        ],
        compactions: [{ end: 2, summary: "Fixture compaction summary.", savedTokens: 17 }],
        timestamp: 1789123456789,
    };
}

function installInitScript(context, conversation, runNonce) {
    return context.addInitScript(({ history, nonce, secret }) => {
        if (!/^https?:$/.test(location.protocol)) return;
        if (localStorage.getItem("phase3-fixture-seeded") !== nonce) {
            localStorage.setItem("llama_gui_conversations", JSON.stringify([history]));
            localStorage.setItem("llama_gui_chat_web_search_enabled", "true");
            localStorage.setItem("llama_gui_chat_web_search_max_results", "7");
            localStorage.setItem("llama_gui_chat_settings_collapsed", "false");
            localStorage.setItem("llama_gui_chat_history_collapsed", "false");
            localStorage.setItem("phase3-fixture-seeded", nonce);
        }
        window.__phase3Messages = [];
        window.__phase3ApiSecret = secret;
        window.addEventListener("message", event => {
            try {
                window.__phase3Messages.push({
                    direction: "received",
                    origin: event.origin,
                    data: JSON.parse(JSON.stringify(event.data)),
                });
            } catch (error) {
                console.debug("Phase 3 message capture skipped", error);
            }
        });
    }, { history: conversation, nonce: runNonce, secret: API_SECRET });
}

function installHangingCompletion(context, options = {}) {
    return context.addInitScript(({ toolRound }) => {
        const nativeFetch = window.fetch.bind(window);
        const encoder = new TextEncoder();
        window.fetch = (input, init) => {
            const requestUrl = typeof input === "string" ? input : input?.url || "";
            const pathname = new URL(requestUrl, location.href).pathname;
            if (pathname !== "/api/chat/completions") return nativeFetch(input, init);
            const count = Number(localStorage.getItem("phase4-completion-count") || 0) + 1;
            localStorage.setItem("phase4-completion-count", String(count));
            if (toolRound && count === 1) {
                const events = [
                    { choices: [{ delta: { tool_calls: [{ index: 0, id: "phase4-clock-1", type: "function", function: { name: "get_datetime", arguments: "{}" } }] } }] },
                    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
                    "[DONE]",
                ].map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
                return Promise.resolve(new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
            }
            let ended = false;
            let controllerRef = null;
            const close = () => {
                if (ended) return;
                ended = true;
                controllerRef?.close();
            };
            const stream = new ReadableStream({
                start(controller) {
                    controllerRef = controller;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial response survives host reload." } }] })}\n\n`));
                    if (init?.signal) {
                        if (init.signal.aborted) close();
                        else init.signal.addEventListener("abort", close, { once: true });
                    }
                },
                cancel() { ended = true; },
            });
            return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
        };
    }, { toolRound: Boolean(options.toolRound) });
}

function makeStatus(overrides = {}) {
    const runtime = {
        tool: "llama-server",
        model: "phase3-fixture-model.gguf",
        alias: "phase3-fixture-alias",
        generation: 73,
        ready: true,
    };
    return Object.assign({
        installed: true,
        running: true,
        active_process_tool: "llama-server",
        active_runtime: runtime,
        runtime_generation: runtime.generation,
        external_chat_target: null,
        backend: "cpu",
        version: "phase3-fixture",
        tag: "phase3-fixture",
        official_install: { backend: "cpu", tag: "phase3-fixture", version: "phase3-fixture", files_present: true },
        available_backends: [{ id: "cpu", label: "CPU" }],
        executables: { "llama-cli": true, "llama-server": true, "llama-bench": true },
        models_dir: "models",
        models_arg_root: "models",
        models_dir_is_default: true,
        models_dir_available: true,
        models_dir_error: "",
    }, overrides);
}

async function installApiRoutes(context, options = {}) {
    const calls = [];
    const status = makeStatus(options.status || {});
    await context.route("**/api/**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        let body = null;
        try { body = request.postDataJSON(); } catch (error) { body = null; }
        let page = null;
        try { page = request.frame().page(); } catch (error) { page = null; }
        const call = { method: request.method(), pathname: url.pathname, search: url.search, headers: request.headers(), body, page };
        calls.push(call);

        if (url.pathname === "/api/status") return route.fulfill({ json: status });
        if (url.pathname === "/api/llama/health") return route.fulfill({ json: { state: "ready", ready: true, generation: 73 } });
        if (url.pathname === "/api/llama/props") return route.fulfill({ json: { chat_template_caps: { supports_reasoning_effort: true } } });
        if (url.pathname === "/api/llama/metrics") return route.fulfill({ contentType: "text/plain", body: "llamacpp:requests_processing 0\nllamacpp:tokens_predicted_total 3\n" });
        if (url.pathname === "/api/llama/slots") return route.fulfill({ json: [] });
        if (url.pathname === "/api/output") return route.fulfill({ json: { lines: [], running: true, runtime_generation: 73, next_cursor: 0 } });
        if (url.pathname === "/api/system-stats") return route.fulfill({ json: { sampled_at: 1789123456, interval_seconds: 2, system: {}, gpus: [], gpu_setup: [] } });
        if (url.pathname === "/api/models") return route.fulfill({ json: [{ name: "phase3-fixture-model.gguf", size_mb: 1 }] });
        if (url.pathname === "/api/presets") return route.fulfill({ json: [] });
        if (url.pathname === "/api/presets/fingerprint") return route.fulfill({ json: { fingerprint: "phase3-fixture" } });
        if (url.pathname === "/api/releases") return route.fulfill({ json: [] });
        if (url.pathname === "/api/backends") return route.fulfill({ json: { warning: "" } });
        if (url.pathname === "/api/remote-tunnel/status") return route.fulfill({ json: { running: false, starting: false, url: "" } });
        if (url.pathname === "/api/app-update-status") return route.fulfill({ json: { state: "up_to_date", can_update: false } });
        if (url.pathname === "/api/chat/context") {
            return route.fulfill({ json: { status: "ok", capacity: 4096, prompt_tokens: 128, reply_reserve: 256, remaining: 3712 } });
        }
        if (url.pathname === "/api/chat/completions") {
            return route.fulfill({
                contentType: "text/event-stream",
                body: [
                    `data: ${json({ choices: [{ delta: { content: "Popup completion confirmed." } }] })}`,
                    `data: ${json({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 22, completion_tokens: 4 } })}`,
                    "data: [DONE]",
                    "",
                ].join("\n"),
            });
        }
        // All other API calls are harmless JSON fixtures. In particular, this
        // keeps app bootstrap from reaching a real backend route.
        return route.fulfill({ json: { ok: true } });
    });
    return { calls };
}

function callsFor(calls, pathname) {
    return calls.filter(call => call.pathname === pathname);
}

async function selectChat(page) {
    await page.waitForFunction(() => Boolean(window.LlamaGui?.chatUi));
    await page.locator('.nav-item[data-section="chat"]').click();
    await page.locator("#section-chat").waitFor({ state: "visible" });
    await page.locator("#chat-input").waitFor({ state: "visible" });
}

async function readStoredConversations(page) {
    return page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]"));
}

async function assertNoSecret(page, label) {
    const state = await page.evaluate(() => ({
        url: location.href,
        storage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
        messages: window.__phase3Messages || [],
    }));
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes(API_SECRET), false, `${label} must not persist or transfer the fixture API secret`);
    assert.equal(state.url.includes(API_SECRET), false, `${label} URL must not contain credentials`);
    for (const message of state.messages) {
        assert.equal(JSON.stringify(message).includes(API_SECRET), false, `${label} transfer messages must exclude credentials`);
    }
    return state;
}

test("direct Chat window URL without an opener shows a safe unavailable shell", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const callsResult = await installApiRoutes(context);
    const pageErrors = [];
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.goto(`${server.baseUrl}?${POPUP_QUERY}`, { waitUntil: "domcontentloaded" });
    await page.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "visible" });
    assert.equal(await page.locator(CHAT_WINDOW_PLACEHOLDER).getAttribute("role"), "region");
    const placeholderLabelId = await page.locator(CHAT_WINDOW_PLACEHOLDER).getAttribute("aria-labelledby");
    assert.ok(placeholderLabelId, "the Chat placeholder region must reference its heading");
    assert.equal(await page.locator(`#${placeholderLabelId}`).textContent(), "Chat window unavailable");
    assert.equal(await page.locator(CHAT_HOST_STATUS).getAttribute("role"), "status");
    assert.match(await page.locator(`${CHAT_WINDOW_PLACEHOLDER} h3`).textContent(), /Chat window unavailable/i);
    assert.match(await page.locator(`${CHAT_WINDOW_PLACEHOLDER} p`).textContent(), /same browser|cannot share/i);
    assert.equal(await page.locator("#section-quick-launch").isVisible(), false);
    assert.equal(await page.locator("#app-sidebar").isVisible(), false);
    assert.equal(await page.locator(CHAT_POP_OUT).isDisabled(), true);
    assert.equal(await page.locator(CHAT_RETURN).isDisabled(), true);
    assert.equal(await page.locator(CHAT_OPEN_FULL_GUI).isVisible(), true);
    const fullGuiUrl = await page.locator(CHAT_OPEN_FULL_GUI).getAttribute("href");
    const parsedFullGuiUrl = new URL(fullGuiUrl, server.baseUrl);
    assert.equal(parsedFullGuiUrl.origin, new URL(server.baseUrl).origin);
    assert.equal(parsedFullGuiUrl.searchParams.has("chat-window"), false);
    assert.deepEqual(callsResult.calls, [], "an orphan detached page must not start app requests");
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [], "an orphan detached page must not write storage");
    assert.deepEqual(pageErrors, [], "an orphan detached page must not raise uncaught errors");
});

test("Chat pop-out contains URL construction and live host getter failures", { timeout: 60_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const pageErrors = [];
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    await installInitScript(context, representativeConversation(), randomUUID());
    const { calls } = await installApiRoutes(context);
    const main = await context.newPage();
    await main.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    await main.locator("#chat-input").fill("Draft survives startup exceptions.");
    const historyBefore = await readStoredConversations(main);
    await main.evaluate(() => {
        const OriginalURL = window.URL;
        try {
            window.URL = class { constructor() { throw new Error("fixture URL construction failure"); } };
            document.querySelector("#btn-chat-popout").click();
        } finally { window.URL = OriginalURL; }
    });
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "visible" });
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), true);
    assert.deepEqual(await main.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("llama-gui:chat-window-probe:"))), []);
    assert.deepEqual(await readStoredConversations(main), historyBefore);
    await main.evaluate(() => {
        const chatWindow = window.LlamaGui.chatWindow;
        const getAdapter = chatWindow.getPeerHostAdapter;
        chatWindow.getPeerHostAdapter = candidate => {
            const adapter = getAdapter(candidate);
            return adapter && { ...adapter, getSettings() { throw new Error("fixture live host getter failure"); } };
        };
    });
    const popupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const popup = await popupPromise;
    await popup.locator("body[data-chat-window-error]").waitFor({ state: "visible" });
    assert.match(await popup.locator(`${CHAT_WINDOW_PLACEHOLDER} h3`).textContent(), /unavailable/i);
    assert.equal(await popup.locator("#chat-layout").isVisible(), false);
    assert.equal(await popup.locator("#section-quick-launch").isVisible(), false);
    assert.equal(await popup.locator(CHAT_RETURN).isDisabled(), true);
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), true);
    assert.equal(await main.locator("#chat-input").inputValue(), "Draft survives startup exceptions.");
    assert.deepEqual(await readStoredConversations(main), historyBefore);
    assert.deepEqual(await main.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("llama-gui:chat-window-probe:"))), []);
    assert.equal(calls.some(call => /\/(launch|stop|shutdown|restart)$/.test(call.pathname)), false);
    assert.deepEqual(pageErrors, []);
});

test("Chat recovery focuses a safe control when no server disables the composer", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await installInitScript(context, representativeConversation(), randomUUID());
    await installApiRoutes(context, {
        status: {
            running: false,
            active_process_tool: null,
            active_runtime: null,
            runtime_generation: null,
        },
    });

    const main = await context.newPage();
    await main.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    await main.waitForFunction(() => document.getElementById("chat-input")?.disabled === true, null, { timeout: 10_000 });
    assert.equal(await main.locator("#chat-input").isDisabled(), true, "the no-server fixture disables the composer");
    assert.equal(await main.locator(CHAT_POP_OUT).isDisabled(), false, "no server does not disable Chat ownership handoff");

    const popupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const popup = await popupPromise;
    await popup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    await main.waitForFunction(() => document.activeElement?.id === "btn-chat-show-window", null, { timeout: 10_000 });
    await main.keyboard.press("Tab");
    await main.waitForFunction(() => document.activeElement?.id === "btn-chat-return-here", null, { timeout: 10_000 });
    assert.equal(await main.locator(CHAT_RETURN_HERE).isDisabled(), false);
    assert.equal(await main.locator(CHAT_RETURN_HERE).getAttribute("aria-disabled"), "false");
    await popup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.waitForFunction(() => {
        const input = document.getElementById("chat-input");
        const active = document.activeElement;
        return Boolean(input && input.disabled && active && active.matches("button, a")
            && !active.hidden && !active.disabled && active.getAttribute("aria-disabled") !== "true");
    }, null, { timeout: 10_000 });
    const focusedFallback = await main.evaluate(() => document.activeElement?.id || "");
    assert.equal(focusedFallback, "btn-chat-popout", "recovery falls back to the original enabled Pop out control when the composer is disabled");
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 3_000 });
});

test("Recover chat here explains ownership contention and retries after the owner closes", { timeout: 60_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await installInitScript(context, representativeConversation(), randomUUID());
    const { calls } = await installApiRoutes(context);

    const owner = await context.newPage();
    await owner.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(owner);
    await owner.locator("#chat-input").fill("Keep this unsent draft during recovery.");
    const observer = await context.newPage();
    await observer.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await observer.locator('.nav-item[data-section="chat"]').click();
    await observer.locator(CHAT_RETURN_HERE).click();
    await observer.locator(CHAT_HOST_STATUS).waitFor({ state: "visible" });
    assert.match(await observer.locator(CHAT_HOST_STATUS).innerText(), /another Llama GUI tab or window still owns it/);
    assert.equal(await observer.locator("#chat-layout").isVisible(), false);
    assert.equal(await owner.locator("#chat-input").inputValue(), "Keep this unsent draft during recovery.");

    await owner.close();
    // Closing the page can finish before Chromium releases its Web Lock.
    // Recovery intentionally uses ifAvailable, so retry only after release.
    await observer.waitForFunction(async () => {
        const { held } = await navigator.locks.query();
        const name = window.LlamaGui.chatWindow._hostView.coordinator.lockName;
        return !held.some(lock => lock.name === name);
    });
    await observer.locator(CHAT_RETURN_HERE).click();
    await observer.locator("#chat-layout").waitFor({ state: "visible" });
    assert.equal(await observer.locator("#chat-input").inputValue(), "Keep this unsent draft during recovery.");
    assert.equal(await observer.locator("#chat-input").isEnabled(), true);
    assert.equal(await observer.locator(CHAT_HOST_STATUS).isVisible(), false);
    assert.equal(callsFor(calls, "/api/chat/completions").length, 0, "recovery must not send the draft");

    await observer.close();
    const failed = await context.newPage();
    await failed.addInitScript(() => {
        const request = navigator.locks.request.bind(navigator.locks);
        let failures = 2;
        navigator.locks.request = (...args) => {
            if (failures-- > 0) return Promise.reject(new Error("Fixture lock service failure"));
            return request(...args);
        };
    });
    await failed.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await failed.locator('.nav-item[data-section="chat"]').click();
    assert.equal(await failed.locator("#chat-window-placeholder-heading").innerText(), "Chat needs recovery");
    await failed.locator(CHAT_RETURN_HERE).click();
    await failed.locator(CHAT_HOST_STATUS).waitFor({ state: "visible" });
    assert.match(await failed.locator(CHAT_HOST_STATUS).innerText(), /Chat could not be restored/);
    await failed.locator(CHAT_RETURN_HERE).click();
    await failed.locator("#chat-layout").waitFor({ state: "visible" });
    assert.equal(await failed.locator("#chat-input").inputValue(), "Keep this unsent draft during recovery.");
    assert.equal(await failed.locator(CHAT_HOST_STATUS).isVisible(), false);
});

test("Chat initialization failure leaves an unavailable shell without breaking the GUI", { timeout: 60_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    let chatUiRouteHit = false;
    await context.route(/\/js\/chat\/chat-main\.js(?:\?|$)/, async route => {
        chatUiRouteHit = true;
        const source = fs.readFileSync(path.join(UI_ROOT, "js", "chat", "chat-main.js"), "utf8");
        await route.fulfill({
            contentType: "text/javascript; charset=utf-8",
            body: `${source}\nwindow.__phase4ChatInitFailureFixture = true; window.LlamaGui.chatUi.init = () => { throw new Error("fixture Chat init failure"); };`,
        });
    });
    await installApiRoutes(context);
    const pageErrors = [];
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__phase4ChatInitFailureFixture === true);
    assert.equal(chatUiRouteHit, true, "the Chat init failure fixture replaced the versioned chat-main script");
    await page.locator("#section-quick-launch").waitFor({ state: "visible" });
    await page.locator('.nav-item[data-section="configure"]').click();
    await page.locator("#section-configure").waitFor({ state: "visible" });
    assert.equal(await page.locator("#config-search").isVisible(), true, "Configure remains initialized after Chat failure");
    await page.locator('.nav-item[data-section="chat"]').click();
    await page.locator("#section-chat").waitFor({ state: "visible" });
    await page.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "visible" });
    assert.match(await page.locator(`${CHAT_WINDOW_PLACEHOLDER} h3`).textContent(), /Chat unavailable/i);
    assert.equal(await page.locator("#chat-layout").isVisible(), false, "a failed Chat init cannot expose an editable orphan layout");
    assert.equal(await page.locator("#chat-input").isEditable(), false, "a failed Chat init leaves the composer inert");
    assert.equal(await page.locator(CHAT_POP_OUT).isDisabled(), true, "a failed Chat init disables pop-out");
    assert.equal(await page.locator(CHAT_RETURN).isDisabled(), true, "a failed Chat init disables return");
    await page.locator('.nav-item[data-section="quick-launch"]').click();
    await page.locator("#section-quick-launch").waitFor({ state: "visible" });
    assert.deepEqual(pageErrors, [], "Chat initialization failure is rendered without an uncaught page error");
});

test("real same-context Chat pop-out use and return cycle", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const pageErrors = [];
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    const conversation = representativeConversation();
    const runNonce = `phase3-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    const { calls } = await installApiRoutes(context);
    let main;
    let popup;

    main = await context.newPage();
    await main.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    assert.equal(await main.locator(CHAT_RETURN).isVisible(), false, "main Return control is hidden before opening a pop-out");
    assert.equal(await main.locator(CHAT_POP_OUT).getAttribute("title"), "Open Chat in a separate window");
    if (await main.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await main.locator("#btn-open-history").click();
    }
    await main.locator(".chat-history-item-title").filter({ hasText: conversation.title }).click();
    await main.waitForFunction(() => window.LlamaGui.chatUi.captureSnapshot().conversation.id === "phase3-fixture-conversation");
    await main.evaluate(() => {
        window.LlamaGui.flagCore.setFlagValue("api_key", "fixture-api-secret-must-not-persist");
        window.LlamaGui.flagCore.setFlagValue("temperature", 0.37);
        window.LlamaGui.chatUi.refreshSidebarUI();
    });
    if (await main.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await main.locator("#btn-open-sidebar").click();
    }
    await main.locator("#chat-system-prompt").fill("Main system prompt survives the detached window.");
    await main.locator("#chat-input").fill("Draft survives the detached window.");
    await main.locator("#btn-chat-focus").click();
    assert.equal(await main.locator("#btn-chat-focus").getAttribute("aria-pressed"), "true");
    const layoutStorageBefore = await main.evaluate(() => ({
        history: localStorage.getItem("llama_gui_chat_history_collapsed"),
        settings: localStorage.getItem("llama_gui_chat_settings_collapsed"),
    }));

    const forbiddenBefore = new Map(["/api/launch", "/api/stop", "/api/shutdown", "/api/restart", "/api/chat/target"].map(pathname => [pathname, callsFor(calls, pathname).length]));
    const statusBefore = callsFor(calls, "/api/status").length;
    const metricsBefore = callsFor(calls, "/api/llama/metrics").length;
    const popupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await popup.locator("#chat-input").waitFor({ state: "visible" });
    await popup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    assert.equal(new URL(popup.url()).searchParams.get("chat-window"), "1");
    assert.equal(await main.locator(CHAT_WINDOW_PLACEHOLDER).isVisible(), true);
    assert.equal(await main.locator(CHAT_WINDOW_PLACEHOLDER).getAttribute("role"), "region");
    const detachedPlaceholderLabelId = await main.locator(CHAT_WINDOW_PLACEHOLDER).getAttribute("aria-labelledby");
    assert.ok(detachedPlaceholderLabelId, "the detached Chat placeholder must reference its heading");
    assert.equal(await main.locator(`#${detachedPlaceholderLabelId}`).textContent(), "Chat is open in another window");
    assert.equal(await main.locator(CHAT_HOST_STATUS).getAttribute("role"), "status");
    assert.equal(await main.locator(CHAT_SHOW_WINDOW).isVisible(), true);
    assert.equal(await main.locator(CHAT_RETURN_HERE).isVisible(), true);
    assert.equal(await main.locator(CHAT_RETURN_HERE).isDisabled(), false, "Return chat here is enabled after handoff");
    assert.equal(await main.locator(CHAT_RETURN_HERE).getAttribute("aria-disabled"), "false");
    await main.waitForFunction(() => {
        const placeholder = document.getElementById("chat-window-placeholder");
        const active = document.activeElement;
        const showWindow = document.getElementById("btn-chat-show-window");
        return Boolean(placeholder && active === showWindow && placeholder.contains(active)
            && !active.hidden && !active.disabled && active.getAttribute("aria-disabled") !== "true");
    }, null, { timeout: 10_000 });
    assert.equal(await popup.locator("#chat-messages").textContent().then(text => text.includes("Stored answer selected for the pop-out.")), true);
    assert.equal(await popup.locator("#chat-system-prompt").inputValue(), "Main system prompt survives the detached window.");
    assert.equal(await popup.locator("#chat-input").inputValue(), "Draft survives the detached window.");

    const popupSnapshot = await popup.evaluate(() => window.LlamaGui.chatUi.captureSnapshot({ source: "phase3-test" }));
    assert.equal(popupSnapshot.conversation.id, conversation.id);
    assert.equal(popupSnapshot.conversation.titleCustom, true);
    assert.equal(popupSnapshot.messages.length, 6);
    assert.equal(popupSnapshot.messages[1].versions.length, 2);
    assert.equal(popupSnapshot.messages[1].versionIndex, 0);
    assert.equal(popupSnapshot.messages[1].toolMessages[0].content, "Fixture tool result");
    assert.equal(popupSnapshot.compactions[0].summary, "Fixture compaction summary.");

    // The popup edits the host owned sampler through the existing Chat control.
    if (await popup.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-sidebar").click();
    }
    await popup.locator("#chat-num-temp").fill("0.73");
    await popup.locator("#chat-num-temp").dispatchEvent("change");
    await main.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.73);
    assert.equal(await popup.locator("#chat-num-temp").inputValue(), "0.73");
    await main.evaluate(() => {
        window.LlamaGui.flagCore.setFlagValue("temperature", undefined);
        window.LlamaGui.flagCore.setFlagValue("alias", "phase3-runtime-alias");
        window.LlamaGui.chatUi.refreshSidebarUI();
    });
    await popup.waitForFunction(() => window.LlamaGui.chatUi.getChatSamplerValues().temperature === undefined);
    assert.equal(await popup.locator("#chat-num-temp").inputValue(), "");
    assert.equal(await popup.locator("#chat-active-model").textContent(), "phase3-fixture-alias");

    await popup.locator("#chat-input").fill("Send from the real popup.");
    await popup.locator("#btn-chat-send").click();
    await popup.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Popup completion confirmed."));
    const completionCalls = callsFor(calls, "/api/chat/completions");
    assert.equal(completionCalls.length, 1, "popup use must make one completion request");
    assert.equal(completionCalls[0].headers.authorization, "Bearer " + API_SECRET);
    assert.equal(completionCalls[0].body.messages.at(-1).content, "Send from the real popup.");
    assert.equal(completionCalls[0].body.messages[0].content.includes("Main system prompt"), true);
    assert.equal(JSON.stringify(completionCalls[0].body).includes(API_SECRET), false,
        "the serialized completion body must exclude the API secret at every nesting level");

    await popup.setViewportSize({ width: 1280, height: 900 });
    if (await popup.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-history").click();
    }
    if (await popup.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-sidebar").click();
    }
    if (await popup.locator("#chat-tools").isHidden()) await popup.locator("#btn-chat-tools").click();
    await popup.locator("#chat-context-details").evaluate(element => { element.open = true; });
    const desktopScreenshotPath = path.join(require("node:os").tmpdir(), "llama-gui-phase4-chat-popout-1280x900.png");
    await popup.screenshot({ path: desktopScreenshotPath });

    await popup.setViewportSize({ width: 390, height: 560 });
    if (await popup.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-history").click();
    }
    if (await popup.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-sidebar").click();
    }
    if (await popup.locator("#chat-tools").isHidden()) await popup.locator("#btn-chat-tools").click();
    await popup.locator("#chat-context-details").evaluate(element => { element.open = true; });
    await popup.locator("#chat-input").scrollIntoViewIfNeeded();
    const screenshotPath = path.join(require("node:os").tmpdir(), "llama-gui-phase4-chat-popout-390x560.png");
    await popup.screenshot({ path: screenshotPath });
    assert.equal(await popup.locator("#chat-history-panel").evaluate(element => !element.classList.contains("collapsed")), true);
    assert.equal(await popup.locator("#chat-sidebar").evaluate(element => !element.classList.contains("collapsed")), true);
    assert.equal(await popup.locator("#chat-tools").isVisible(), true);
    for (const selector of [CHAT_RETURN, "#btn-chat-send"]) {
        assert.equal(await popup.locator(selector).evaluate(element => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
                && element.contains(document.elementFromPoint(x, y));
        }), true, `${selector} stays reachable with both panels and Context open`);
    }

    // The shared picker and confirmation wiring also runs in the dedicated
    // bootstrap. Keyboard cancellation must leave this workspace unchanged.
    const [chooser] = await Promise.all([
        popup.waitForEvent("filechooser"),
        popup.getByRole("button", { name: "Load character card", exact: true }).press("Enter"),
    ]);
    await chooser.setFiles([]);
    for (const selector of [".chat-history-item-delete", "#btn-chat-clear", "#btn-delete-all-history"]) {
        await popup.locator(selector).first().click();
        await popup.locator("#confirm-modal").waitFor({ state: "visible" });
        assert.equal(await popup.locator('[role="dialog"]:visible').count(), 1);
        assert.equal(await popup.locator(CHAT_RETURN).isDisabled(), true, "a pending confirmation blocks transfer");
        const cancelBounds = await popup.locator("#confirm-modal-cancel").boundingBox();
        assert.ok(cancelBounds && cancelBounds.x >= 0 && cancelBounds.y >= 0
            && cancelBounds.x + cancelBounds.width <= 390 && cancelBounds.y + cancelBounds.height <= 560);
        await popup.keyboard.press("Escape");
        await popup.locator("#confirm-modal").waitFor({ state: "hidden" });
    }
    assert.equal((await readStoredConversations(popup)).length, 1, "cancelled popup dialogs preserve history");

    const popupStatusCalls = calls.filter(call => call.page === popup && ["/api/status", "/api/llama/metrics", "/api/llama/slots", "/api/system-stats", "/api/output"].includes(call.pathname));
    assert.deepEqual(popupStatusCalls, [], "detached Chat must reuse the host status/metrics stream");
    for (const [pathname, count] of forbiddenBefore) assert.equal(callsFor(calls, pathname).length, count, `${pathname} must not run while opening or using Chat`);
    assert.equal(callsFor(calls, "/api/status").slice(statusBefore).every(call => call.page === main), true,
        "any status poll during handoff must remain owned by the main page");
    assert.equal(callsFor(calls, "/api/llama/metrics").slice(metricsBefore).every(call => call.page === main), true,
        "any metrics poll during handoff must remain owned by the main page");

    await assertNoSecret(main, "main window");
    await assertNoSecret(popup, "popup window");

    await popup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.locator("#chat-input").waitFor({ state: "visible" });
    await main.waitForFunction(() => {
        const input = document.getElementById("chat-input");
        return Boolean(input && document.activeElement === input && !input.disabled);
    }, null, { timeout: 10_000 });
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 3_000 });
    assert.equal(await main.locator("#btn-chat-focus").getAttribute("aria-pressed"), "true", "focus layout returns to the main window");
    assert.equal(await main.locator("#chat-system-prompt").inputValue(), "Main system prompt survives the detached window.");
    assert.equal(await main.locator("#chat-input").inputValue(), "", "sending clears the transferred draft after the popup request");
    const conversations = await readStoredConversations(main);
    assert.equal(conversations.length, 1, "return must preserve one conversation without duplicates");
    assert.equal(conversations[0].id, conversation.id);
    assert.equal(conversations[0].titleCustom, true);
    assert.equal(conversations[0].messages.filter(message => message.role === "assistant").length, 4);
    assert.deepEqual(await main.evaluate(() => ({
        history: localStorage.getItem("llama_gui_chat_history_collapsed"),
        settings: localStorage.getItem("llama_gui_chat_settings_collapsed"),
    })), layoutStorageBefore, "popup panel changes must not overwrite main preferences");
    assert.equal(await main.locator(CHAT_SHOW_WINDOW).isVisible(), false, "return restores the normal pop-out action");
    assert.equal(await main.locator(CHAT_RETURN_HERE).isVisible(), false, "return hides detached-only controls from the main view");
    assert.equal(await main.locator(CHAT_RETURN).isVisible(), false, "main Return control remains hidden after returning");
    assert.equal(await main.locator(CHAT_POP_OUT).isDisabled(), false, "Pop out is enabled after returning");
    const popoutTitleAfterReturn = await main.locator(CHAT_POP_OUT).getAttribute("title");
    assert.equal(popoutTitleAfterReturn, "Open Chat in a separate window");
    assert.doesNotMatch(popoutTitleAfterReturn || "", /owned|busy|unavailable/i, "Pop out does not retain an old disabled reason");
    for (const [pathname, count] of forbiddenBefore) assert.equal(callsFor(calls, pathname).length, count, `${pathname} must not run while returning Chat`);
    await assertNoSecret(main, "returned main window");
    assert.deepEqual(pageErrors, [], "the complete pop-out lifecycle remains free of uncaught errors");
    t.diagnostic(`Phase 4 popup screenshots: ${desktopScreenshotPath}, ${screenshotPath}`);

});

test("blocked and blank pop-outs preserve ownership and a fresh transfer identity", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const pageErrors = [];
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    const conversation = representativeConversation();
    const runNonce = `phase4-reopen-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    await context.addInitScript(() => {
        window.__phase4BufferedOwnerAcks = [];
        window.addEventListener("message", event => {
            if (!window.__phase4HoldOwnerAck || event.data?.type !== "owner-ack") return;
            window.__phase4BufferedOwnerAcks.push(event);
            event.stopImmediatePropagation();
        });
    });
    const { calls } = await installApiRoutes(context);
    let main;

    main = await context.newPage();
    await main.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    if (await main.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await main.locator("#btn-open-history").click();
    }
    await main.locator(".chat-history-item-title").filter({ hasText: conversation.title }).click();
    const forbiddenBefore = new Map(["/api/launch", "/api/stop", "/api/shutdown", "/api/restart", "/api/chat/target"]
        .map(pathname => [pathname, callsFor(calls, pathname).length]));

    // A blocked or blank receiver must leave the original owner and transcript usable.
    await main.locator("#chat-input").fill("Draft survives a blocked pop-out.");
    const beforeBlocked = await main.evaluate(() => ({
        snapshot: window.LlamaGui.chatUi.captureSnapshot(),
        history: localStorage.getItem("llama_gui_conversations"),
    }));
    await main.evaluate(() => {
        window.__phase4OriginalOpen = window.open;
        window.open = () => null;
    });
    await main.locator(CHAT_POP_OUT).click();
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "visible" });
    assert.match(await main.locator(CHAT_HOST_STATUS).textContent(), /remains available|Allow popups/i);
    assert.equal(await main.locator("#chat-input").isVisible(), true);
    assert.equal(await main.locator("#chat-input").isDisabled(), false);
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), true);
    assert.deepEqual(await main.evaluate(() => ({
        snapshot: window.LlamaGui.chatUi.captureSnapshot(),
        history: localStorage.getItem("llama_gui_conversations"),
    })), beforeBlocked, "blocked pop-out preserves the current owner and transcript");
    await main.evaluate(() => window.LlamaGui.chatWindow.notifyHostChange({ type: "status" }));
    assert.equal(await main.locator(CHAT_HOST_STATUS).isVisible(), true, "blocked pop-out status survives a host update");

    await main.evaluate(() => {
        window.open = (_url, name, features) => window.__phase4OriginalOpen("about:blank", name, features);
    });
    const blankPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const blankPopup = await blankPopupPromise;
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await main.locator(CHAT_HOST_STATUS).textContent(), /could not connect|preserved/i);
    assert.equal(await main.locator("#chat-input").isVisible(), true);
    assert.equal(await main.locator("#chat-input").isDisabled(), false);
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), true);
    assert.deepEqual(await main.evaluate(() => ({
        snapshot: window.LlamaGui.chatUi.captureSnapshot(),
        history: localStorage.getItem("llama_gui_conversations"),
    })), beforeBlocked, "blank popup preserves the current owner and transcript");
    await main.evaluate(() => window.LlamaGui.chatWindow.notifyHostChange({ type: "status" }));
    assert.equal(await main.locator(CHAT_HOST_STATUS).isVisible(), true, "blank popup status survives a host update");
    if (!blankPopup.isClosed()) await blankPopup.waitForEvent("close", { timeout: 3_000 });
    assert.equal(blankPopup.isClosed(), true);
    await main.evaluate(() => {
        window.open = window.__phase4OriginalOpen;
        delete window.__phase4OriginalOpen;
    });

    // Capture the first completed handoff before any popup streaming/checkpoint work.
    const firstPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const firstPopup = await firstPopupPromise;
    await firstPopup.waitForLoadState("domcontentloaded");
    await firstPopup.locator("#chat-input").waitFor({ state: "visible" });
    await firstPopup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.coordinator?.getState?.().transfer?.phase === "complete");
    const firstTransfer = await main.evaluate(() => {
        const state = window.LlamaGui.chatWindow._hostView.coordinator.getState();
        const transfer = state.transfer || {};
        return {
            sourceId: state.instanceId,
            sessionId: state.sessionId,
            destinationId: transfer.destinationId,
            transferId: transfer.id,
            revision: transfer.revision,
            phase: transfer.phase,
        };
    });
    assert.equal(firstTransfer.phase, "complete");
    assert.ok(firstTransfer.sourceId && firstTransfer.sessionId && firstTransfer.destinationId && firstTransfer.transferId);
    assert.equal(await firstPopup.locator("#chat-messages").textContent().then(text => text.includes("Stored answer selected for the pop-out.")), true);
    await firstPopup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    if (!firstPopup.isClosed()) await firstPopup.waitForEvent("close", { timeout: 3_000 });

    // Hold the exact owner-ack event while the main source is released. Closing
    // the real popup must leave explicit recovery when the late ack settles.
    // The inert listener was installed before application message listeners.
    await main.evaluate(() => { window.__phase4HoldOwnerAck = true; });
    const midTransferPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    const pendingOpen = main.evaluate(() => window.LlamaGui.chatWindow._hostView.openPopout());
    const midTransferPopup = await midTransferPopupPromise;
    await midTransferPopup.waitForLoadState("domcontentloaded");
    await midTransferPopup.locator("#chat-input").waitFor({ state: "visible" });
    await main.waitForFunction(() => {
        const coordinator = window.LlamaGui.chatWindow._hostView?.coordinator;
        const state = coordinator?.getState?.();
        return state?.transfer?.phase === "awaiting-ack" && state.ownership === false;
    }, null, { timeout: 15_000 });
    await midTransferPopup.close();
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.popup === null, null, { timeout: 15_000 });
    await main.waitForFunction(async () => {
        if (!navigator.locks?.query) return false;
        const locks = await navigator.locks.query();
        return locks.held.length === 0;
    }, null, { timeout: 15_000 });
    assert.equal(await main.evaluate(() => window.__phase4BufferedOwnerAcks.length), 1,
        "the receiver owner-ack must be retained for the close-race replay");
    const lateAckResult = await main.evaluate(() => {
        const event = window.__phase4BufferedOwnerAcks[0];
        const coordinator = window.LlamaGui.chatWindow._hostView.coordinator;
        const handled = coordinator.receiveMessage(event);
        const state = coordinator.getState();
        return { handled, owner: coordinator.isOwner(), status: state.status, transfer: state.transfer };
    });
    assert.equal(await pendingOpen, true, "the buffered ack may settle only the inert source handoff");
    assert.equal(lateAckResult.owner, false, "a late owner-ack cannot restore ownership after popup close");
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.popup === null
        && window.LlamaGui.chatWindow.hasDetachedView?.() === false
        && document.querySelector("#chat-window-placeholder h3")?.textContent === "The Chat window was closed"
        && document.querySelector("#btn-chat-return-here")?.textContent === "Recover chat here", null, { timeout: 15_000 });
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), false,
        "the closed handoff cannot mutate Chat until explicit recovery");
    assert.equal(await main.locator(CHAT_RETURN_HERE).isVisible(), true);
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView.coordinator.isOwner());
    const recoveredState = await main.evaluate(() => window.LlamaGui.chatWindow._hostView.coordinator.getState());
    const replayResult = await main.evaluate(() => {
        const event = window.__phase4BufferedOwnerAcks[0];
        const coordinator = window.LlamaGui.chatWindow._hostView.coordinator;
        coordinator.receiveMessage(event);
        return { owner: coordinator.isOwner(), state: coordinator.getState() };
    });
    assert.equal(replayResult.owner, true, "replaying an old owner-ack cannot unset recovered ownership");
    assert.deepEqual(replayResult.state.transfer, recoveredState.transfer, "an old owner-ack cannot alter the recovered transfer");
    await main.evaluate(() => { window.__phase4HoldOwnerAck = false; });

    const retryPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const retryPopup = await retryPopupPromise;
    await retryPopup.waitForLoadState("domcontentloaded");
    await retryPopup.locator("#chat-input").waitFor({ state: "visible" });
    await retryPopup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView.coordinator.getState().transfer?.phase === "complete");
    const freshTransfer = await main.evaluate(() => {
        const state = window.LlamaGui.chatWindow._hostView.coordinator.getState();
        const transfer = state.transfer || {};
        return {
            sourceId: state.instanceId,
            sessionId: state.sessionId,
            destinationId: transfer.destinationId,
            transferId: transfer.id,
            revision: transfer.revision,
            phase: transfer.phase,
        };
    });
    assert.equal(freshTransfer.sourceId, firstTransfer.sourceId);
    assert.equal(freshTransfer.sessionId, firstTransfer.sessionId);
    assert.notEqual(freshTransfer.destinationId, firstTransfer.destinationId, "a fresh receiver gets a new destination identity");
    assert.notEqual(freshTransfer.transferId, firstTransfer.transferId, "a fresh receiver gets a new transfer identity");
    assert.ok(freshTransfer.revision > firstTransfer.revision, "a fresh handoff advances the durable revision");
    assert.equal(await retryPopup.locator("#chat-messages").textContent().then(text => text.includes("Stored answer selected for the pop-out.")), true);
    await retryPopup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    if (!retryPopup.isClosed()) await retryPopup.waitForEvent("close", { timeout: 3_000 });
    assert.equal((await readStoredConversations(main)).length, 1);
    assert.equal(calls.some(call => call.pathname === "/api/chat/completions"), false,
        "blocked, blank, close-race, and retry coverage need no generated completion");
    for (const [pathname, count] of forbiddenBefore) {
        assert.equal(callsFor(calls, pathname).length, count, `${pathname} must not run during failure recovery`);
    }
    await assertNoSecret(main, "main window after close-race retry");
    assert.deepEqual(pageErrors, [], "failed handoffs and late acknowledgements remain free of uncaught errors");
});

test("idle popup close and deletion recovery use an independently seeded transcript", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addInitScript(() => { window.__LLAMA_GUI_TEST_HOOKS__ = true; });
    const pageErrors = [];
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    const conversation = representativeConversation();
    await installInitScript(context, conversation, `phase4-idle-${randomUUID()}`);
    const { calls } = await installApiRoutes(context);

    const main = await context.newPage();
    await main.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    if (await main.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await main.locator("#btn-open-history").click();
    }
    await main.locator(".chat-history-item-title").filter({ hasText: conversation.title }).click();
    await main.locator("#chat-input").fill("Draft survives an idle popup close.");
    const forbiddenBefore = new Map(["/api/launch", "/api/stop", "/api/shutdown", "/api/restart", "/api/chat/target"]
        .map(pathname => [pathname, callsFor(calls, pathname).length]));
    const popupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await popup.locator("#chat-input").waitFor({ state: "visible" });
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.coordinator?.getState?.().transfer?.phase === "complete");
    await main.waitForFunction(() => document.activeElement?.id === "btn-chat-show-window");
    await main.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await main.waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 10_000 });
    await main.waitForFunction(() => Boolean(inferenceStats?.getTargetKey?.()) && inferencePolling._test.getState().active, null, { timeout: 10_000 });
    // A hidden host must keep producing snapshots for the popup, without a
    // second inference engine/poller or resumed system telemetry polling.
    const hiddenSequence = await main.evaluate(() => inferenceStats.getSnapshot()?.seq || 0);
    const hiddenCallsStart = calls.length;
    await main.waitForFunction(seq => (inferenceStats.getSnapshot()?.seq || 0) >= seq + 2,
        hiddenSequence, { timeout: 15_000 });
    const hiddenInferenceCalls = calls.slice(hiddenCallsStart)
        .filter(call => ["/api/llama/metrics", "/api/llama/slots"].includes(call.pathname));
    assert.ok(hiddenInferenceCalls.some(call => call.pathname === "/api/llama/metrics"));
    assert.ok(hiddenInferenceCalls.some(call => call.pathname === "/api/llama/slots"));
    assert.equal(hiddenInferenceCalls.every(call => call.page === main), true,
        "only the hidden host polls inference while detached Chat is open");
    assert.equal(await popup.evaluate(() => inferencePolling), null,
        "detached Chat does not construct another inference poller");
    assert.equal(await popup.evaluate(() => processOutput), null,
        "detached Chat does not construct an output poller");
    assert.equal(await popup.evaluate(() => inferenceStats), null,
        "detached Chat does not construct another inference engine");
    assert.equal(calls.slice(hiddenCallsStart).some(call => call.pathname === "/api/system-stats"), false,
        "hidden-host inference does not resume system telemetry");
    const statsBeforeClose = await main.evaluate(() => ({
        target: inferenceStats?.getTargetKey?.() || null,
        visible: inferencePolling._test.getState().documentVisible,
        active: inferencePolling._test.getState().active,
    }));
    assert.ok(statsBeforeClose.target, "the idle-close scenario starts with an active inference target");
    assert.equal(statsBeforeClose.active, true, "the idle-close scenario starts with polling active");
    await popup.close();
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.popup === null
        && window.LlamaGui.chatWindow.hasDetachedView?.() === false
        && document.querySelector("#chat-window-placeholder h3")?.textContent === "The Chat window was closed"
        && inferencePolling._test.getState().documentVisible === false
        && inferencePolling._test.getState().hasInitialTimer === false
        && inferencePolling._test.getState().hasTimer === false
        && inferencePolling._test.getState().inFlight === false
        && inferencePolling._test.getState().hasAbortController === false, null, { timeout: 15_000 });
    const closedPopupState = await main.evaluate(() => ({
        detached: window.LlamaGui.chatWindow.hasDetachedView?.(),
        visibility: document.visibilityState,
        placeholderVisible: !document.getElementById("chat-window-placeholder")?.hidden,
        statsVisible: inferencePolling._test.getState().documentVisible,
        statsPolling: inferencePolling._test.getState().active,
        statsInitialTimer: inferencePolling._test.getState().hasInitialTimer,
        statsTimer: inferencePolling._test.getState().hasTimer,
        statsInFlight: inferencePolling._test.getState().inFlight,
        statsAbortController: inferencePolling._test.getState().hasAbortController,
    }));
    assert.equal(closedPopupState.detached, false);
    assert.equal(closedPopupState.visibility, "hidden");
    assert.equal(closedPopupState.placeholderVisible, true);
    assert.equal(closedPopupState.statsVisible, false);
    assert.equal(closedPopupState.statsPolling, false);
    assert.equal(closedPopupState.statsInitialTimer, false);
    assert.equal(closedPopupState.statsTimer, false);
    assert.equal(closedPopupState.statsInFlight, false);
    assert.equal(closedPopupState.statsAbortController, false);
    await main.waitForFunction(() => {
        const action = document.getElementById("btn-chat-return-here");
        return Boolean(action && document.activeElement === action && !action.hidden && !action.disabled
            && action.getAttribute("aria-disabled") !== "true");
    }, null, { timeout: 10_000 });
    assert.equal(await main.locator(CHAT_SHOW_WINDOW).isVisible(), false);
    assert.equal(await main.locator(CHAT_RETURN_HERE).isDisabled(), false);
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await main.locator("#chat-input").inputValue(), "Draft survives an idle popup close.");
    assert.equal(await main.locator("#chat-messages").textContent().then(text => text.includes("Stored answer selected for the pop-out.")), true);
    assert.equal((await readStoredConversations(main)).length, 1);

    const deletePopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const deletePopup = await deletePopupPromise;
    await deletePopup.waitForLoadState("domcontentloaded");
    await deletePopup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    if (await deletePopup.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await deletePopup.locator("#btn-open-history").click();
    }
    await deletePopup.locator("#btn-delete-all-history").click();
    await deletePopup.locator("#confirm-modal-ok").click();
    await deletePopup.waitForFunction(() => JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]").length === 0);
    await deletePopup.close();
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.popup === null
        && document.querySelector("#btn-chat-return-here")?.textContent === "Recover chat here", null, { timeout: 15_000 });
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    const afterDelete = await main.evaluate(() => window.LlamaGui.chatUi.captureSnapshot());
    assert.equal(afterDelete.conversation.id, null, "deletion recovery cannot reuse the deleted conversation identity");
    assert.deepEqual(afterDelete.messages, [], "deletion recovery clears the stale transcript");
    assert.equal((await readStoredConversations(main)).length, 0);
    await assertNoSecret(main, "main window after deletion recovery");
    for (const [pathname, count] of forbiddenBefore) {
        assert.equal(callsFor(calls, pathname).length, count, `${pathname} must not run during idle/deletion recovery`);
    }
    assert.deepEqual(pageErrors, [], "idle and deletion recovery remain free of uncaught errors");
});

test("popup reload and main reload recover the newest checkpoint without resend", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const conversation = representativeConversation();
    const runNonce = `phase4-reload-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    await installHangingCompletion(context, { toolRound: true });
    const { calls } = await installApiRoutes(context);
    let main;
    let popup;

    main = await context.newPage();
    await main.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    if (await main.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await main.locator("#btn-open-history").click();
    }
    await main.locator(".chat-history-item-title").filter({ hasText: conversation.title }).click();
    if (await main.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await main.locator("#btn-open-sidebar").click();
    }
    await main.locator("#chat-system-prompt").fill("Reload recovery system prompt.");
    await main.locator("#chat-input").fill("Draft before popup reload.");

    const popupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await popup.locator("#chat-input").waitFor({ state: "visible" });
    assert.equal(await popup.locator("#chat-input").inputValue(), "Draft before popup reload.");

    // A detached reload consumes the one-shot proof and must show the safe
    // unavailable shell. Recovery is explicit in the main window.
    await popup.reload({ waitUntil: "domcontentloaded" });
    await popup.waitForFunction(() => {
        const placeholder = document.getElementById("chat-window-placeholder");
        return document.body.dataset.chatWindowError === "true" && Boolean(placeholder && !placeholder.hidden);
    });
    const reloadView = await popup.evaluate(() => ({
        error: document.body.dataset.chatWindowError === "true",
        placeholderVisible: !document.getElementById("chat-window-placeholder")?.hidden,
        inputVisible: Boolean(document.getElementById("chat-input")?.offsetParent),
        draft: document.getElementById("chat-input")?.value || "",
        transcript: document.getElementById("chat-messages")?.textContent || "",
    }));
    assert.equal(reloadView.error, true, "an unrecovered popup reload must expose an explicit error state");
    assert.equal(reloadView.placeholderVisible, true);
    assert.equal(reloadView.inputVisible, false, "the unavailable reload shell must not expose an editable composer");
    assert.equal(reloadView.draft, "");
    assert.match(await popup.locator("#chat-window-placeholder h3").textContent(), /Chat window unavailable/i);
    assert.equal(await popup.evaluate(() => localStorage.getItem("phase4-completion-count")), null);
    await popup.close();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "visible" });
    await main.waitForFunction(() => document.querySelector("#btn-chat-return-here")?.textContent === "Recover chat here");
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    assert.equal(await main.locator("#chat-input").inputValue(), "Draft before popup reload.");

    // Start a hanging response in the popup, let the bounded checkpoint fire,
    // then reload the main page. Host loss must abort and checkpoint the partial
    // answer, and the fresh main page must recover it without auto-resending.
    const secondPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    popup = await secondPopupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await popup.locator("#chat-input").waitFor({ state: "visible" });
    await main.waitForFunction(() => window.LlamaGui.chatWindow._hostView?.coordinator?.getState?.().transfer?.phase === "complete");
    const transferIdentity = await main.evaluate(() => {
        const state = window.LlamaGui.chatWindow._hostView.coordinator.getState();
        const transfer = state.transfer || {};
        return {
            sourceId: state.instanceId,
            sessionId: state.sessionId,
            destinationId: transfer.destinationId,
            transferId: transfer.id,
            revision: transfer.revision,
            phase: transfer.phase,
        };
    });
    assert.equal(transferIdentity.phase, "complete");
    if (await popup.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-sidebar").click();
    }
    await popup.locator("#chat-datetime-enabled").check();
    await popup.locator("#chat-input").fill("Partial stream request.");
    await popup.locator("#btn-chat-send").click();
    await popup.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Partial response survives host reload."));
    await popup.waitForFunction(({ sourceId, destinationId, transferId, revision }) => {
        const raw = localStorage.getItem("llama-gui:chat-recovery:v1");
        if (!raw) return false;
        let record;
        try { record = JSON.parse(raw); } catch (error) { return false; }
        const stream = record.snapshot?.streaming;
        const transfer = record.transfer;
        return record.invalidated === false
            && record.phase === "checkpoint"
            && Number.isInteger(record.revision) && record.revision > revision
            && transfer && transfer.sourceId && transfer.destinationId
            && transfer.sourceId === destinationId && transfer.destinationId === destinationId
            && transfer.transferId !== transferId
            && stream?.active === true
            && stream.content?.includes("Partial response survives host reload.")
            && stream.toolMessages?.some(message => JSON.stringify(message).includes("get_datetime") || JSON.stringify(message).includes("phase4-clock-1"));
    }, transferIdentity, { timeout: 15_000 });
    const checkpoint = await popup.evaluate(() => JSON.parse(localStorage.getItem("llama-gui:chat-recovery:v1") || "null"));
    assert.equal(checkpoint.phase, "checkpoint");
    assert.equal(checkpoint.invalidated, false);
    assert.ok(Number.isInteger(checkpoint.revision) && checkpoint.revision > transferIdentity.revision);
    assert.equal(checkpoint.transfer.sourceId, transferIdentity.destinationId);
    assert.equal(checkpoint.transfer.destinationId, transferIdentity.destinationId);
    assert.notEqual(checkpoint.transfer.transferId, transferIdentity.transferId);
    assert.match(JSON.stringify(checkpoint.snapshot), /Partial response survives host reload/);
    assert.match(JSON.stringify(checkpoint.snapshot), /get_datetime|phase4-clock-1/, "tool round is included in the recoverable checkpoint");
    assert.equal(await popup.evaluate(() => localStorage.getItem("phase4-completion-count")), "2");

    await main.reload({ waitUntil: "domcontentloaded" });
    await popup.locator("#chat-window-host-status").waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await popup.locator("#chat-window-host-status").textContent(), /paused|not be resent automatically/i);
    assert.equal(await popup.locator("#btn-chat-send").isDisabled(), true);
    await popup.close();
    // A fresh main document starts as an observer while the failed popup's
    // durable ownership record is quarantined. Navigate to Chat and use its
    // explicit Recover action rather than assuming the composer is live.
    await main.locator('.nav-item[data-section="chat"]').click();
    await main.locator("#section-chat").waitFor({ state: "visible" });
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "visible" });
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.locator("#chat-input").waitFor({ state: "visible" });
    await main.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Partial response survives host reload."));
    assert.equal(await main.evaluate(() => localStorage.getItem("phase4-completion-count")), "2", "recovery must not auto-resend either tool round request");
    const recoveredSnapshot = await main.evaluate(() => window.LlamaGui.chatUi.captureSnapshot());
    assert.match(JSON.stringify(recoveredSnapshot), /get_datetime|phase4-clock-1/, "recovery retains the completed tool exchange");
    assert.equal(calls.filter(call => call.pathname === "/api/chat/completions").length, 0,
        "synthetic hanging completion is isolated from backend routes");
    await popup.close();
    await assertNoSecret(main, "main after reload recovery");
});

test("insecure mapped origin keeps single-window Chat fallback usable", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({
        headless: true,
        args: ["--host-resolver-rules=MAP popout-test.invalid 127.0.0.1"],
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const conversation = representativeConversation();
    const runNonce = `phase4-insecure-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    await installApiRoutes(context);
    const main = await context.newPage();

    const port = new URL(server.baseUrl).port;
    await main.goto(`http://popout-test.invalid:${port}/`, { waitUntil: "domcontentloaded" });
    await selectChat(main);
    const capabilities = await main.evaluate(() => ({
        secureContext: window.isSecureContext,
        locks: typeof navigator.locks,
        popoutDisabled: document.getElementById("btn-chat-popout")?.disabled,
        popoutTitle: document.getElementById("btn-chat-popout")?.title || "",
        placeholderHidden: document.getElementById("chat-window-placeholder")?.hidden,
        inputDisabled: document.getElementById("chat-input")?.disabled,
    }));
    assert.equal(capabilities.secureContext, false, "mapped non-loopback hostname remains an insecure context");
    assert.equal(capabilities.locks, "undefined", "insecure origin has no Web Locks API");
    assert.equal(capabilities.popoutDisabled, true, "unsupported popup capability disables Pop out");
    assert.match(capabilities.popoutTitle, /Web Locks|unavailable/i);
    assert.equal(capabilities.placeholderHidden, true, "single-window fallback keeps the Chat layout usable");
    assert.equal(capabilities.inputDisabled, false, "single-window fallback keeps Send usable");
});


const IMAGE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const imageFile = (name = "sample.png") => ({ name, mimeType: "image/png", buffer: IMAGE_PNG });

async function waitForImageDraft(page, count = 1) {
    await page.waitForFunction(expected => {
        const images = [...document.querySelectorAll("#chat-image-drafts img")];
        return images.length === expected && images.every(image => image.complete && image.naturalWidth > 0)
            && !document.querySelector("#btn-chat-send").disabled;
    }, count);
}

test("image attachments survive pop-out, send, history reload, retry, export and editing", { timeout: 90_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ acceptDownloads: true });
    const { calls } = await installApiRoutes(context);
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    const main = await context.newPage();
    await main.goto(server.baseUrl);
    await selectChat(main);
    await main.locator("#chat-image-file").setInputFiles(imageFile());
    await waitForImageDraft(main);
    await main.setViewportSize({ width: 390, height: 560 });
    const composerBounds = await main.locator("#btn-chat-send").boundingBox();
    assert.ok(composerBounds && composerBounds.y + composerBounds.height <= 560, "attachment preview keeps Send on screen");
    assert.equal(await main.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await main.setViewportSize({ width: 1280, height: 900 });
    // Pending attachments transfer as references, never as base64 in checkpoints.
    const snapshot = await main.evaluate(() => window.LlamaGui.chatUi.captureSnapshot());
    assert.equal(snapshot.inputs.attachments[0].name, "sample.png");
    assert.equal(JSON.stringify(snapshot).includes("data:image"), false);
    const popupPromise = main.waitForEvent("popup");
    await main.locator(CHAT_POP_OUT).click();
    const popup = await popupPromise;
    await popup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    await waitForImageDraft(popup);
    await popup.locator("#btn-chat-send").click();
    await popup.waitForFunction(() => document.querySelectorAll("#chat-messages .chat-message").length === 2
        && !document.querySelector("#btn-chat-send").disabled);
    const first = callsFor(calls, "/api/chat/completions").at(-1).body;
    assert.deepEqual(first.messages[0].content.map(part => part.type), ["image_url"]);
    assert.match(first.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
    assert.equal((await readStoredConversations(popup))[0].messages[0].content, "");
    assert.equal(JSON.stringify(await readStoredConversations(popup)).includes("data:image"), false);
    await popup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.reload();
    await selectChat(main);
    await main.locator("#btn-open-history").click();
    await main.locator(".chat-history-item-title").filter({ hasText: "Image conversation" }).click();
    await main.waitForFunction(() => document.querySelector("#chat-messages img")?.naturalWidth === 1);
    await main.locator("#btn-chat-regenerate").click();
    await main.waitForFunction(() => !document.querySelector("#btn-chat-send").disabled);
    const retry = callsFor(calls, "/api/chat/completions").at(-1).body;
    assert.deepEqual(retry.messages, first.messages, "retry must resend the original image-only turn");
    await main.locator("#chat-input").fill("Describe both images.");
    const jpeg = await main.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 2; canvas.height = 2;
        return canvas.toDataURL("image/jpeg").split(",")[1];
    });
    await main.locator("#chat-image-file").setInputFiles({ name: "second.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });
    await waitForImageDraft(main);
    await main.locator("#btn-chat-send").click();
    await main.waitForFunction(() => document.querySelectorAll("#chat-messages .chat-message").length === 4
        && !document.querySelector("#btn-chat-send").disabled);
    const followUp = callsFor(calls, "/api/chat/completions").at(-1).body;
    assert.deepEqual(followUp.messages[0], first.messages[0], "later turns preserve earlier images");
    assert.equal(followUp.messages.at(-1).content[0].text, "Describe both images.");
    assert.match(followUp.messages.at(-1).content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.ok(callsFor(calls, "/api/chat/context").some(call => Array.isArray(call.body.messages.at(-1).content)),
        "context preview must measure image content parts");
    const downloadPromise = main.waitForEvent("download");
    await main.locator(".chat-history-item-export").click();
    const download = await downloadPromise;
    const output = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.equal(Object.keys(output.images).length, 2);
    assert.match(Object.values(output.images)[0], /^data:image\/png;base64,/);
    await main.locator('#chat-messages button[aria-label="Edit and resend"]').first().click();
    await main.locator("#confirm-modal-ok").click();
    await waitForImageDraft(main);
    await main.locator('#chat-image-drafts button').click();
    await main.locator("#chat-input").fill("Replacement text without an image");
    await main.locator("#btn-chat-send").click();
    await main.waitForFunction(() => !document.querySelector("#btn-chat-send").disabled);
    assert.equal(callsFor(calls, "/api/chat/completions").at(-1).body.messages[0].content, "Replacement text without an image");
    const conversations = await readStoredConversations(main);
    assert.equal(conversations.length, 2, "editing preserves the original image in its history branch");
    assert.ok(conversations.some(conversation => conversation.messages[0].attachments?.length));
    assert.deepEqual(errors, []);
});

for (const automatic of [false, true]) test(`image ${automatic ? "automatic" : "manual"} compaction preserves originals and retains recent media`, { timeout: 90_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ acceptDownloads: true });
    const { calls } = await installApiRoutes(context);
    await context.route("**/api/chat/context", async route => {
        const body = route.request().postDataJSON();
        calls.push({ pathname: "/api/chat/context", body });
        const media = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
            .filter(part => part.type === "image_url").length;
        const prompt = Math.ceil(JSON.stringify(body.messages).length / 4) + media * 512;
        const remaining = 8192 - prompt - (body.max_tokens || 0);
        return route.fulfill({ json: { status: automatic && media === 3 ? "warning" : remaining < 0 ? "overflow" : "ok",
            capacity: 8192, prompt_tokens: prompt, remaining } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.baseUrl);
    await selectChat(page);
    for (let turn = 0; turn < 3; turn++) {
        if (turn < 2) {
            await page.locator("#chat-image-file").setInputFiles(imageFile(turn ? "recent.png" : "older.png"));
            await waitForImageDraft(page);
        }
        await page.locator("#chat-input").fill(`Turn ${turn}: ` + "Preserve these discussed details. ".repeat(100));
        await page.locator("#btn-chat-send").click();
        await page.waitForFunction(count => document.querySelectorAll("#chat-messages .chat-message").length === count
            && !document.querySelector("#btn-chat-send").disabled, (turn + 1) * 2);
    }
    const original = (await readStoredConversations(page))[0].messages;
    await page.locator("#chat-image-file").setInputFiles(imageFile("draft.png"));
    await waitForImageDraft(page);
    await page.locator("#btn-chat-tools").click();
    if (automatic) {
        await page.locator("#chat-auto-compact-toggle").check();
        await page.locator("#btn-chat-tools").click();
        await page.locator("#btn-chat-send").click();
    } else {
        await page.locator("#btn-chat-compact").click();
    }
    await page.waitForFunction(() => window.LlamaGui.chatUi.captureSnapshot().compactions.length === 1
        && !window.LlamaGui._chatInternal.state.compactionController && !window.LlamaGui._chatInternal.state.chatStreaming);
    assert.match(await page.locator("#chat-compaction-status").textContent(), /Older images are no longer sent/);
    assert.match(await page.locator(".chat-compaction-marker").textContent(), /Undo compaction to restore/);
    const compacted = callsFor(calls, "/api/chat/context").map(call => call.body)
        .filter(body => JSON.stringify(body.messages).includes("Older images omitted"));
    assert.ok(compacted.some(body => body.messages.at(-1).content?.[0]?.type === "image_url"), "count image-only draft");
    assert.ok(compacted.every(body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(part => part.type === "image_url").length <= 2), "older image leaves working context");
    const summaries = callsFor(calls, "/api/chat/completions").filter(call => call.body.gui_require_context);
    assert.equal(summaries.length, 1);
    assert.ok(!JSON.stringify(summaries[0].body).includes("data:image"));
    assert.match(JSON.parse(summaries[0].body.messages[1].content).messages[0].content, /older.png/);
    if (!automatic) {
        await page.locator("#btn-chat-tools").click();
        await page.locator("#btn-chat-send").click();
        await page.waitForFunction(() => !window.LlamaGui._chatInternal.state.chatStreaming
            && window.LlamaGui.chatUi.captureSnapshot().messages.length === 8);
    }
    assert.deepEqual((await readStoredConversations(page))[0].messages.slice(0, 6), original);
    await page.reload();
    await selectChat(page);
    await page.locator("#btn-open-history").click();
    await page.locator(".chat-history-item-title").first().click();
    await page.locator(".chat-compaction-marker").waitFor();
    const downloadPromise = page.waitForEvent("download");
    await page.locator(".chat-history-item-export").click();
    const exported = JSON.parse(fs.readFileSync(await (await downloadPromise).path(), "utf8"));
    assert.equal(Object.keys(exported.images).length, 3);
    assert.deepEqual(exported.messages.slice(0, 6), original);
    // A second compaction drops the next older image; Undo restores each boundary.
    await page.locator("#btn-chat-tools").click();
    await page.locator("#btn-chat-compact").click();
    await page.waitForFunction(() => window.LlamaGui.chatUi.captureSnapshot().compactions.length === 2
        && !window.LlamaGui._chatInternal.state.compactionController);
    assert.match(await page.evaluate(() => JSON.stringify(window.LlamaGui._chatInternal.buildChatBody(
        window.LlamaGui._chatInternal.state.chatMessages))), /older.png[\s\S]*recent.png/);
    for (const expected of [1, 0]) {
        await page.locator("#btn-chat-tools-undo-compaction").click();
        assert.equal(await page.evaluate(() => window.LlamaGui.chatUi.captureSnapshot().compactions.length), expected);
        if (expected) await page.locator("#btn-chat-tools").click();
    }
    assert.equal(await page.evaluate(() => window.LlamaGui._chatInternal.buildChatBody(window.LlamaGui._chatInternal.state.chatMessages)
        .messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === "image_url").length), 3);
    assert.deepEqual(errors, []);
});

test("image validation, missing storage and text-only models fail visibly", { timeout: 90_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const { calls } = await installApiRoutes(context);
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await selectChat(page);
    const invalid = [
        { file: { name: "document.txt", mimeType: "text/plain", buffer: Buffer.from("text") }, error: "Only JPEG and PNG" },
        { file: { name: "fake.png", mimeType: "image/png", buffer: Buffer.from("not an image") }, error: "not a valid JPEG or PNG" },
        { file: { name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) }, error: "2 MiB" },
    ];
    for (const { file, error } of invalid) {
        await page.locator("#chat-image-file").setInputFiles(file);
        await page.waitForFunction(text => document.querySelector("#chat-image-status").textContent.includes(text)
            && !document.querySelector("#btn-chat-send").disabled, error);
        assert.equal(await page.locator("#chat-image-drafts img").count(), 0);
    }
    await page.locator("#chat-image-file").setInputFiles(Array.from({ length: 5 }, (_, index) => imageFile(`${index}.png`)));
    await page.waitForFunction(() => document.querySelector("#chat-image-status").textContent.includes("four images"));
    await page.locator("#chat-image-file").setInputFiles(imageFile());
    await waitForImageDraft(page);
    await page.locator("#btn-chat-send").click();
    await page.waitForFunction(() => !document.querySelector("#btn-chat-send").disabled);
    // Lose the persisted bytes and reload so the cache cannot conceal missing data.
    await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open("llama_gui_chat_images", 1); request.onsuccess = () => resolve(request.result); });
        await new Promise(resolve => { const tx = db.transaction("images", "readwrite"); tx.objectStore("images").clear(); tx.oncomplete = resolve; });
        db.close();
    });
    await page.reload();
    await selectChat(page);
    await page.locator("#btn-open-history").click();
    await page.locator(".chat-history-item-title").click();
    await page.locator("#chat-input").fill("What was in that image?");
    const before = callsFor(calls, "/api/chat/completions").length;
    await page.locator("#btn-chat-send").click();
    await page.waitForFunction(() => document.querySelector("#chat-image-status").textContent.includes("Image unavailable"));
    assert.equal(callsFor(calls, "/api/chat/completions").length, before);
    await context.route("**/api/llama/props", route => route.fulfill({ json: { modalities: { vision: false } } }));
    await page.reload();
    await selectChat(page);
    await page.waitForFunction(() => document.querySelector("#btn-chat-attach").disabled);
    assert.match(await page.locator("#btn-chat-attach").getAttribute("title"), /vision model/);
    const blockedContext = await browser.newContext();
    await installApiRoutes(blockedContext);
    await blockedContext.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: undefined }));
    const blocked = await blockedContext.newPage();
    await blocked.goto(server.baseUrl);
    await selectChat(blocked);
    await blocked.locator("#chat-image-file").setInputFiles(imageFile());
    await blocked.waitForFunction(() => document.querySelector("#chat-image-status").textContent.includes("browser storage"));
    assert.equal(await blocked.locator("#chat-image-drafts img").count(), 0);
});


test("image cleanup preserves history, drafts and recovery while collecting unused bytes", { timeout: 30_000 }, async t => {
    const server = await startUiServer();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await installApiRoutes(context);
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await selectChat(page);
    await page.locator("#chat-image-file").setInputFiles(imageFile());
    await waitForImageDraft(page);
    const remaining = await page.evaluate(async () => {
        const I = window.LlamaGui._chatInternal;
        const db = await new Promise(resolve => { const request = indexedDB.open("llama_gui_chat_images", 1); request.onsuccess = () => resolve(request.result); });
        const ref = id => ({ id, name: `${id}.png`, type: "image/png", size: 10 });
        const ids = ["saved-image", "draft-image", "checkpoint-image", "orphan-image", "recent-unused"];
        await new Promise(resolve => {
            const tx = db.transaction("images", "readwrite");
            for (const id of ids) tx.objectStore("images").put({ ...ref(id), data: "data:image/png;base64,AA==", created: id === "recent-unused" ? Date.now() : 1 });
            tx.oncomplete = resolve;
        });
        localStorage.setItem("llama_gui_conversations", JSON.stringify([{ id: "saved", messages: [{ role: "user", content: "", attachments: [ref("saved-image")] }] }]));
        I.state.draftImages = [ref("draft-image")];
        localStorage.setItem("llama-gui:chat-recovery:v1", JSON.stringify({ snapshot: { inputs: { attachments: [ref("checkpoint-image")] } } }));
        await I.pruneImages();
        const keys = await new Promise(resolve => {
            const tx = db.transaction("images", "readonly");
            const request = tx.objectStore("images").getAllKeys();
            request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return keys;
    });
    assert.ok(!remaining.includes("orphan-image"));
    for (const id of ["checkpoint-image", "draft-image", "saved-image", "recent-unused"]) assert.ok(remaining.includes(id));
});
