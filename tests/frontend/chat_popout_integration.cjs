const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");

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

function contentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
    }[ext] || "application/octet-stream";
}

function startUiServer() {
    const server = http.createServer((request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" });
            response.end();
            return;
        }
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
        } catch (error) {
            response.writeHead(400);
            response.end("Bad request");
            return;
        }
        const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const filePath = path.resolve(UI_ROOT, relative);
        if (filePath !== UI_ROOT && !filePath.startsWith(UI_ROOT + path.sep)) {
            response.writeHead(403);
            response.end("Forbidden");
            return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        response.writeHead(200, {
            "Content-Type": contentType(filePath),
            "Cache-Control": "no-store",
        });
        if (request.method === "HEAD") response.end();
        else response.end(fs.readFileSync(filePath));
    });
    return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", onError);
            const address = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${address.port}/`,
                async close() {
                    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
                    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
                },
            });
        });
    });
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

function makeStatus() {
    const runtime = {
        tool: "llama-server",
        model: "phase3-fixture-model.gguf",
        alias: "phase3-fixture-alias",
        generation: 73,
        ready: true,
    };
    return {
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
    };
}

async function installApiRoutes(context) {
    const calls = [];
    const status = makeStatus();
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
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const callsResult = await installApiRoutes(context);
    const pageErrors = [];
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    t.after(async () => {
        await context.close();
        await browser.close();
        await server.close();
    });

    await page.goto(`${server.baseUrl}?${POPUP_QUERY}`, { waitUntil: "domcontentloaded" });
    await page.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "visible" });
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

test("real same-context Chat pop-out use and return cycle", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const pageErrors = [];
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    const conversation = representativeConversation();
    const runNonce = `phase3-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    const { calls } = await installApiRoutes(context);
    let main;
    let popup;
    t.after(async () => {
        await context.close();
        await browser.close();
        await server.close();
    });

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
    assert.equal(await main.locator(CHAT_SHOW_WINDOW).isVisible(), true);
    assert.equal(await main.locator(CHAT_RETURN_HERE).isVisible(), true);
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
    assert.equal(completionCalls[0].body.messages.some(message => message.content === API_SECRET), false);

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

    // A blocked direct window.open leaves the current Chat usable and explains
    // the single-window fallback without changing the durable conversation.
    await main.locator("#chat-input").fill("Draft survives a blocked pop-out.");
    const historyBeforeBlockedPopout = await readStoredConversations(main);
    const snapshotBeforeBlockedPopout = await main.evaluate(() => {
        const snapshot = window.LlamaGui.chatUi.captureSnapshot();
        return { conversation: snapshot.conversation, messages: snapshot.messages, draft: snapshot.inputs.draft };
    });
    await main.evaluate(() => {
        window.__phase4OriginalOpen = window.open;
        window.open = () => null;
    });
    await main.locator(CHAT_POP_OUT).click();
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "visible" });
    assert.match(await main.locator(CHAT_HOST_STATUS).textContent(), /remains available|Allow popups/i);
    assert.equal(await main.locator("#chat-input").isVisible(), true, "blocked pop-out keeps the source Chat usable");
    assert.equal(await main.locator("#chat-input").isDisabled(), false, "blocked pop-out keeps source input enabled");
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), true, "blocked pop-out leaves the source as owner");
    assert.deepEqual(await main.evaluate(() => {
        const snapshot = window.LlamaGui.chatUi.captureSnapshot();
        return { conversation: snapshot.conversation, messages: snapshot.messages, draft: snapshot.inputs.draft };
    }), snapshotBeforeBlockedPopout, "blocked pop-out preserves the source workspace");
    assert.deepEqual(await readStoredConversations(main), historyBeforeBlockedPopout, "blocked pop-out preserves history");
    await main.evaluate(() => window.LlamaGui.chatWindow.notifyHostChange({ type: "status" }));
    assert.equal(await main.locator(CHAT_HOST_STATUS).isVisible(), true, "blocked pop-out banner survives a host status update");
    await main.evaluate(() => {
        window.open = window.__phase4OriginalOpen;
        delete window.__phase4OriginalOpen;
    });
    const retryPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const retryPopup = await retryPopupPromise;
    await retryPopup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    await retryPopup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "hidden" });
    if (!retryPopup.isClosed()) await retryPopup.waitForEvent("close", { timeout: 3_000 });

    // A real blank popup exercises the bounded handshake failure path. The
    // source remains owner and the failure closes only the unusable receiver.
    await main.locator("#chat-input").fill("Draft survives a blank popup.");
    const historyBeforeBlankPopup = await readStoredConversations(main);
    const snapshotBeforeBlankPopup = await main.evaluate(() => {
        const snapshot = window.LlamaGui.chatUi.captureSnapshot();
        return { conversation: snapshot.conversation, messages: snapshot.messages, draft: snapshot.inputs.draft };
    });
    await main.evaluate(() => {
        window.__phase4OriginalOpen = window.open;
        window.open = (_url, name, features) => window.__phase4OriginalOpen("about:blank", name, features);
    });
    const blankPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const blankPopup = await blankPopupPromise;
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await main.locator(CHAT_HOST_STATUS).textContent(), /could not connect|preserved/i);
    assert.equal(await main.evaluate(() => window.LlamaGui.chatUi.getTransferState().allowed), true, "failed handshake preserves source ownership");
    assert.deepEqual(await main.evaluate(() => {
        const snapshot = window.LlamaGui.chatUi.captureSnapshot();
        return { conversation: snapshot.conversation, messages: snapshot.messages, draft: snapshot.inputs.draft };
    }), snapshotBeforeBlankPopup, "failed handshake preserves the source workspace");
    assert.deepEqual(await readStoredConversations(main), historyBeforeBlankPopup, "failed handshake preserves history");
    await main.evaluate(() => window.LlamaGui.chatWindow.notifyHostChange({ type: "status" }));
    assert.equal(await main.locator(CHAT_HOST_STATUS).isVisible(), true, "failed handshake banner survives a host status update");
    if (!blankPopup.isClosed()) await blankPopup.waitForEvent("close", { timeout: 3_000 });
    assert.equal(blankPopup.isClosed(), true, "failed handshake closes the unusable popup");
    await main.evaluate(() => {
        window.open = window.__phase4OriginalOpen;
        delete window.__phase4OriginalOpen;
    });

    // A new popup document gets a new WindowProxy after the first return. The
    // host must replace the peer identity and complete a fresh transfer rather
    // than reusing the closed receiver's source reference.
    const secondPopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const secondPopup = await secondPopupPromise;
    await secondPopup.waitForLoadState("domcontentloaded");
    await secondPopup.locator("#chat-input").waitFor({ state: "visible" });
    await secondPopup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    assert.notEqual(secondPopup, popup, "a repeated pop-out must use a new popup document");
    assert.equal(new URL(secondPopup.url()).searchParams.get("chat-window"), "1");
    assert.equal(await secondPopup.locator("#chat-messages").textContent().then(text => text.includes("Popup completion confirmed.")), true);
    const secondSnapshot = await secondPopup.evaluate(() => window.LlamaGui.chatUi.captureSnapshot({ source: "phase4-reopen" }));
    assert.equal(secondSnapshot.conversation.id, conversation.id);
    assert.equal(secondSnapshot.messages.filter(message => message.role === "assistant").length, 4);
    await secondPopup.locator(CHAT_RETURN).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    await main.locator(CHAT_HOST_STATUS).waitFor({ state: "hidden" });
    if (!secondPopup.isClosed()) await secondPopup.waitForEvent("close", { timeout: 3_000 });
    assert.equal((await readStoredConversations(main)).length, 1, "reopening and returning must not duplicate history");
    for (const [pathname, count] of forbiddenBefore) assert.equal(callsFor(calls, pathname).length, count, `${pathname} must not run while reopening Chat`);
    await assertNoSecret(main, "main window after repeated return");

    // Closing an idle receiver leaves its newest checkpoint recoverable in the
    // source. Recovery is explicit and must restore the draft without opening
    // a third owner or issuing any lifecycle request.
    await main.locator("#chat-input").fill("Draft survives an idle popup close.");
    const closePopupPromise = main.waitForEvent("popup", { timeout: 10_000 });
    await main.locator(CHAT_POP_OUT).click();
    const closePopup = await closePopupPromise;
    await closePopup.waitForLoadState("domcontentloaded");
    await closePopup.locator("#chat-input").waitFor({ state: "visible" });
    await closePopup.close();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "visible" });
    await main.waitForFunction(() => document.querySelector("#btn-chat-return-here")?.textContent === "Recover chat here");
    assert.equal(await main.locator(CHAT_SHOW_WINDOW).isVisible(), false, "closed receiver recovery must hide Show window until a receiver exists");
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    assert.equal(await main.locator("#chat-input").inputValue(), "Draft survives an idle popup close.");
    assert.equal(await main.locator("#chat-messages").textContent().then(text => text.includes("Popup completion confirmed.")), true);
    assert.equal((await readStoredConversations(main)).length, 1, "explicit close recovery must preserve one conversation");
    for (const [pathname, count] of forbiddenBefore) assert.equal(callsFor(calls, pathname).length, count, `${pathname} must not run while recovering closed Chat`);
    await assertNoSecret(main, "main window after close recovery");

    const deletePopupPromise = main.waitForEvent("popup");
    await main.locator(CHAT_POP_OUT).click();
    const deletePopup = await deletePopupPromise;
    await deletePopup.locator(CHAT_RETURN).waitFor({ state: "visible" });
    if (await deletePopup.locator("#chat-history-panel").evaluate(element => element.classList.contains("collapsed"))) {
        await deletePopup.locator("#btn-open-history").click();
    }
    await deletePopup.locator("#btn-delete-all-history").click();
    await deletePopup.locator("#confirm-modal-ok").click();
    await deletePopup.waitForFunction(() => JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]").length === 0);
    await deletePopup.close();
    await main.waitForFunction(() => document.querySelector("#btn-chat-return-here")?.textContent === "Recover chat here");
    await main.locator(CHAT_RETURN_HERE).click();
    await main.locator(CHAT_WINDOW_PLACEHOLDER).waitFor({ state: "hidden" });
    const afterDelete = await main.evaluate(() => window.LlamaGui.chatUi.captureSnapshot());
    assert.equal(afterDelete.conversation.id, null, "recovery cannot reuse the deleted conversation identity");
    assert.deepEqual(afterDelete.messages, [], "a stale source transcript cannot survive deletion recovery");
    assert.equal((await readStoredConversations(main)).length, 0);
    assert.deepEqual(pageErrors, [], "both application bootstraps remain free of uncaught errors");

    t.diagnostic(`Phase 4 popup screenshots: ${desktopScreenshotPath}, ${screenshotPath}`);
});

test("popup reload and main reload recover the newest checkpoint without resend", { timeout: 120_000 }, async t => {
    const server = await startUiServer();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const conversation = representativeConversation();
    const runNonce = `phase4-reload-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    await installHangingCompletion(context, { toolRound: true });
    const { calls } = await installApiRoutes(context);
    let main;
    let popup;
    t.after(async () => {
        await context.close();
        await browser.close();
        await server.close();
    });

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

    // Reloading the detached document may lose the verified host session. It
    // must show the safe recovery state and never submit the recovered draft.
    await popup.reload({ waitUntil: "domcontentloaded" });
    await popup.waitForFunction(() => {
        const input = document.getElementById("chat-input");
        const placeholder = document.getElementById("chat-window-placeholder");
        return document.body.dataset.chatWindowError === "true"
            || Boolean(input && input.offsetParent)
            || Boolean(placeholder && !placeholder.hidden);
    });
    const reloadView = await popup.evaluate(() => ({
        error: document.body.dataset.chatWindowError === "true",
        placeholderVisible: !document.getElementById("chat-window-placeholder")?.hidden,
        inputVisible: Boolean(document.getElementById("chat-input")?.offsetParent),
        draft: document.getElementById("chat-input")?.value || "",
        transcript: document.getElementById("chat-messages")?.textContent || "",
    }));
    if (reloadView.error || !reloadView.inputVisible) {
        assert.equal(reloadView.error, true, "an unrecovered popup reload must expose an explicit error state");
        assert.equal(reloadView.placeholderVisible, true);
        assert.match(await popup.locator("#chat-window-placeholder h3").textContent(), /Chat window unavailable/i);
    } else {
        assert.equal(reloadView.draft, "Draft before popup reload.");
        assert.equal(reloadView.transcript.includes("Stored answer selected for the pop-out."), true);
    }
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
    if (await popup.locator("#chat-sidebar").evaluate(element => element.classList.contains("collapsed"))) {
        await popup.locator("#btn-open-sidebar").click();
    }
    await popup.locator("#chat-datetime-enabled").check();
    await popup.locator("#chat-input").fill("Partial stream request.");
    await popup.locator("#btn-chat-send").click();
    await popup.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Partial response survives host reload."));
    await new Promise(resolve => setTimeout(resolve, 900));
    const checkpoint = await popup.evaluate(() => JSON.parse(localStorage.getItem("llama-gui:chat-recovery:v1") || "null"));
    assert.match(JSON.stringify(checkpoint), /Partial response survives host reload/);
    assert.match(JSON.stringify(checkpoint), /get_datetime|phase4-clock-1/, "tool round is included in the recoverable checkpoint");
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
    const browser = await chromium.launch({
        headless: true,
        args: ["--host-resolver-rules=MAP popout-test.invalid 127.0.0.1"],
    });
    const context = await browser.newContext();
    const conversation = representativeConversation();
    const runNonce = `phase4-insecure-${randomUUID()}`;
    await installInitScript(context, conversation, runNonce);
    await installApiRoutes(context);
    const main = await context.newPage();
    t.after(async () => {
        await context.close();
        await browser.close();
        await server.close();
    });

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
