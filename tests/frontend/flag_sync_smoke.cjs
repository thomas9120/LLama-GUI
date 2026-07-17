const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const UI_DIR = path.join(ROOT, "ui");
const START_PORT = Number(process.env.LLAMA_GUI_SMOKE_PORT || 5240);

function loadPlaywright() {
    try {
        return require("playwright");
    } catch (error) {
        throw new Error(
            "Playwright smoke tests require the dev-only playwright package. Run npm ci before npm run test:frontend."
        );
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortOpen(port) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 500 }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on("timeout", () => {
            req.destroy();
            resolve(false);
        });
        req.on("error", () => resolve(false));
    });
}

async function findFreePort(startPort) {
    for (let port = startPort; port < startPort + 20; port += 1) {
        if (!(await isPortOpen(port))) return port;
    }
    throw new Error(`No free port found from ${startPort} to ${startPort + 19}`);
}

async function startStaticServer(port) {
    const python = process.env.PYTHON || "python";
    const server = spawn(python, ["-m", "http.server", String(port), "-d", UI_DIR], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    let stderr = "";
    server.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });

    for (let i = 0; i < 40; i += 1) {
        if (server.exitCode !== null) {
            throw new Error(`Static server exited early (${server.exitCode}): ${stderr}`);
        }
        if (await isPortOpen(port)) return server;
        await wait(100);
    }

    server.kill();
    throw new Error(`Static server did not become ready on port ${port}`);
}

async function selectSection(page, section) {
    await page.click(`.nav-item[data-section="${section}"]`);
    await page.waitForSelector(`#section-${section}`, { state: "visible" });
}

// Range inputs cannot be page.fill()ed; set the value and fire input instead.
async function setRangeValue(page, selector, value) {
    await page.evaluate(([sel, val]) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Missing element ${sel}`);
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }, [selector, value]);
}

async function main() {
    const { chromium } = loadPlaywright();
    const port = await findFreePort(START_PORT);
    const server = await startStaticServer(port);
    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();
        const chatCompletionBodies = [];
        const chatCompletionHeaders = [];
        const launchBodies = [];
        const metricsHeaders = [];
        const slotsHeaders = [];
        const pageErrors = [];
        const releaseRequests = [];
        const activateCustomRequests = [];
        let statusRunning = false;
        let activeProcessTool = "";
        let installedBackend = "cpu";
        let chatResponseMode = "ok";

        page.on("pageerror", (error) => {
            pageErrors.push(error.message || String(error));
        });
        await page.route("**/api/**", async (route) => {
            const url = new URL(route.request().url());
            const pathName = url.pathname;
            if (pathName === "/api/chat/completions") {
                chatCompletionBodies.push(JSON.parse(route.request().postData() || "{}"));
                chatCompletionHeaders.push(route.request().headers());
                let chatStreamBody = [
                    'data: {"choices":[{"delta":{"content":"ok"}}]}',
                    "",
                    "data: [DONE]",
                    "",
                ].join("\n");
                if (chatResponseMode === "reasoning-only") {
                    chatStreamBody = [
                        'data: {"choices":[{"delta":{"reasoning_content":"hidden thought"}}]}',
                        "",
                        "data: [DONE]",
                        "",
                    ].join("\n");
                } else if (chatResponseMode === "think-content") {
                    chatStreamBody = [
                        'data: {"choices":[{"delta":{"content":"<think>raw thought</think>\\nFinal visible"}}]}',
                        "",
                        "data: [DONE]",
                        "",
                    ].join("\n");
                }
                await route.fulfill({
                    status: 200,
                    contentType: "text/event-stream",
                    body: chatStreamBody,
                });
                return;
            }
            if (pathName === "/api/launch") {
                launchBodies.push(JSON.parse(route.request().postData() || "{}"));
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ pid: 123, command: "smoke launch" }),
                });
                return;
            }
            if (pathName === "/api/models") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([{ name: "smoke-model.gguf", size_mb: 1 }]),
                });
                return;
            }
            if (pathName === "/api/status") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        installed: true,
                        running: statusRunning,
                        active_process_tool: activeProcessTool,
                        backend: installedBackend,
                        tag: installedBackend === "custom" ? "custom" : "smoke",
                        available_backends: [
                            { id: "cpu", label: "CPU" },
                            { id: "custom", label: "Custom (User-Provided)" },
                        ],
                        executables: {
                            "llama-cli": true,
                            "llama-server": true,
                            "llama-bench": installedBackend !== "custom",
                        },
                    }),
                });
                return;
            }
            if (pathName === "/api/llama/buffer-types") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ buffers: ["CPU", "CUDA0"], default: "CUDA0" }),
                });
                return;
            }
            if (pathName === "/api/releases") {
                releaseRequests.push(url.search);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([{ tag: "smoke", published: "2026-01-01T00:00:00Z" }]),
                });
                return;
            }
            if (pathName === "/api/presets") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([]),
                });
                return;
            }
            if (pathName === "/api/activate-custom") {
                activateCustomRequests.push(JSON.parse(route.request().postData() || "{}"));
                installedBackend = "custom";
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        ok: true,
                        found: ["llama-cli", "llama-server"],
                        missing: ["llama-bench"],
                        missing_required: [],
                    }),
                });
                return;
            }
            if (pathName === "/api/remote-tunnel/status") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ running: false, starting: false, url: "" }),
                });
                return;
            }
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        });

        await page.route("**/api/llama/metrics**", async (route) => {
            metricsHeaders.push(route.request().headers());
            await route.fulfill({
                status: 200,
                contentType: "text/plain",
                body: [
                    "llamacpp:prompt_tokens_total 0",
                    "llamacpp:prompt_tokens_seconds 0",
                    "llamacpp:tokens_predicted_total 0",
                    "llamacpp:predicted_tokens_seconds 0",
                ].join("\n"),
            });
        });

        await page.route("**/api/llama/slots**", async (route) => {
            slotsHeaders.push(route.request().headers());
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { id: 0, n_ctx: 1000, speculative: false, is_processing: false },
                    {
                        id: 1,
                        n_ctx: 1000,
                        speculative: false,
                        is_processing: false,
                        next_token: [{ n_decoded: 125, n_remain: 875 }],
                    },
                ]),
            });
        });

        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.LlamaGui?.flagCore && window.LlamaGui?.configFlagsUi);
        await page.waitForSelector("#flag-ctx_size", { state: "attached" });

        assert.equal(await page.locator("#chat-slider-temp").getAttribute("step"), "0.01");

        const toastSecurity = await page.evaluate(() => {
            showToast('<img src=x onerror="window.__toastXss = true">', "info");
            const toast = document.querySelector("#toast-container .toast:last-child");
            return {
                text: toast?.textContent || "",
                parsedImageCount: toast?.querySelectorAll("img").length || 0,
                xssFlag: Boolean(window.__toastXss),
            };
        });
        assert.match(toastSecurity.text, /<img src=x/);
        assert.equal(toastSecurity.parsedImageCount, 0);
        assert.equal(toastSecurity.xssFlag, false);
        const toastUx = await page.evaluate(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const container = document.querySelector("#toast-container");
            container.querySelectorAll(".toast").forEach((toast) => toast.remove());
            showToast("dismiss me", "warning", { duration: 0 });
            const clickToast = container.querySelector(".toast");
            clickToast.click();
            await wait(260);
            const dismissedOnClick = container.querySelectorAll(".toast").length === 0;
            for (let i = 0; i < 7; i += 1) {
                showToast(`toast ${i}`, "info", { duration: 0 });
            }
            await wait(260);
            const cappedCount = container.querySelectorAll(".toast").length;
            const lastToast = container.querySelector(".toast:last-child");
            const closeButton = lastToast.querySelector(".toast-close");
            closeButton.click();
            await wait(260);
            return {
                role: container.getAttribute("role"),
                live: container.getAttribute("aria-live"),
                dismissedOnClick,
                cappedCount,
                dismissedOnClose: !Array.from(container.querySelectorAll(".toast")).some((toast) =>
                    toast.textContent.includes("toast 6")
                ),
                closeLabel: closeButton.getAttribute("aria-label"),
            };
        });
        assert.equal(toastUx.role, "status");
        assert.equal(toastUx.live, "polite");
        assert.equal(toastUx.dismissedOnClick, true);
        assert.equal(toastUx.cappedCount, 5);
        assert.equal(toastUx.dismissedOnClose, true);
        assert.equal(toastUx.closeLabel, "Dismiss notification");
        await page.evaluate(() => {
            document.querySelectorAll("#toast-container .toast").forEach((toast) => toast.remove());
        });

        await page.waitForFunction(() => document.querySelector("#quick-launch-status")?.textContent.includes("Select a model"));
        assert.equal(await page.locator("#btn-quick-launch").isDisabled(), true);
        assert.equal(await page.locator("#btn-sidebar-launch").isDisabled(), true);

        const sourceSecurity = await page.evaluate(() => {
            const wrap = document.createElement("div");
            wrap.className = "chat-message-content";
            const bubble = document.createElement("div");
            bubble.className = "chat-bubble";
            wrap.appendChild(bubble);
            document.body.appendChild(wrap);
            window.LlamaGui.chatRendering.renderChatSources(bubble, [
                { index: 1, title: "Unsafe", url: "javascript:alert(1)" },
                { index: 2, title: "Safe", url: "https://example.com/path" },
            ]);
            const chips = Array.from(wrap.querySelectorAll(".chat-source-chip"));
            return chips.map((chip) => ({
                tag: chip.tagName,
                href: chip.getAttribute("href"),
                text: chip.textContent,
            }));
        });
        assert.equal(sourceSecurity[0].tag, "SPAN");
        assert.equal(sourceSecurity[0].href, null);
        assert.equal(sourceSecurity[1].tag, "A");
        assert.equal(sourceSecurity[1].href, "https://example.com/path");

        await page.waitForFunction(() => (
            document.querySelector("#server-url")?.textContent === "http://127.0.0.1:8080" &&
            document.querySelector("#quick-server-url")?.textContent === "http://127.0.0.1:8080"
        ));
        const serverAddresses = await page.evaluate(() => ({
            configure: {
                url: document.querySelector("#server-url").getAttribute("href"),
                webUi: document.querySelector("#server-webui").getAttribute("href"),
            },
            quickLaunch: {
                url: document.querySelector("#quick-server-url").getAttribute("href"),
                webUi: document.querySelector("#quick-server-webui").getAttribute("href"),
            },
        }));
        assert.deepEqual(serverAddresses, {
            configure: { url: "http://127.0.0.1:8080", webUi: "http://127.0.0.1:8080/" },
            quickLaunch: { url: "http://127.0.0.1:8080", webUi: "http://127.0.0.1:8080/" },
        });

        const quickProfileOptions = await page.$$eval("#quick-profile-select option", (options) =>
            options.map((option) => option.value)
        );
        assert.ok(!quickProfileOptions.includes("low-memory"));

        await page.selectOption("#quick-profile-select", "long-context");
        await page.dispatchEvent("#quick-profile-select", "change");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().ctx_size === 128000);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().fit_ctx === 128000);
        await page.waitForFunction(() => document.querySelector("#command-preview-text")?.textContent.includes("-c 128000"));
        assert.match(await page.textContent("#quick-profile-summary"), /128000 context/i);

        await page.selectOption("#quick-context-preset", "custom");
        await page.fill("#quick-context-custom", "12345");
        await page.dispatchEvent("#quick-context-custom", "input");
        await page.waitForFunction(() => document.querySelector("#flag-ctx_size")?.value === "12345");
        await page.waitForFunction(() => document.querySelector("#command-preview-text")?.textContent.includes("-c 12345"));
        assert.equal(await page.inputValue("#flag-ctx_size"), "12345");

        await selectSection(page, "configure");
        await page.fill("#config-search", "gpu layers");
        await page.waitForSelector("#flag-gpu_layers", { state: "visible" });
        await page.fill("#flag-gpu_layers", "7");
        await page.dispatchEvent("#flag-gpu_layers", "input");
        await page.waitForFunction(() => document.querySelector("#quick-gpu-mode")?.value === "custom");
        await page.waitForFunction(() => document.querySelector("#quick-gpu-custom")?.value === "7");
        assert.match(await page.textContent("#command-preview-text"), /(?:-ngl|--gpu-layers) 7/);

        await page.fill("#flag-gpu_layers", "abc");
        await page.dispatchEvent("#flag-gpu_layers", "input");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().gpu_layers === undefined);
        await page.waitForFunction(() => !document.querySelector("#command-preview-text")?.textContent.includes("-ngl 7"));
        assert.ok(!(await page.textContent("#command-preview-text")).includes("-ngl abc"));

        await page.fill("#flag-gpu_layers", " 9 ");
        await page.dispatchEvent("#flag-gpu_layers", "input");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().gpu_layers === "9");
        assert.match(await page.textContent("#command-preview-text"), /(?:-ngl|--gpu-layers) 9/);

        await page.fill("#config-search", "expert");
        await page.waitForSelector("#flag-override_tensor", { state: "visible" });
        await page.waitForFunction(() => document.querySelector(".override-tensor-buffer-select")?.value === "CUDA0");
        await page.evaluate(() => {
            window.LlamaGui.flagCore.setMultipleFlagValues({ cpu_moe: true, n_cpu_moe: 2 });
        });
        await page.click(".override-tensor-helper .btn");
        await page.waitForFunction(() => (
            window.LlamaGui.flagCore.getFlagValues().override_tensor === "blk.*.ffn_.*_exps.weight=CUDA0"
        ));
        await page.waitForFunction(() => {
            const values = window.LlamaGui.flagCore.getFlagValues();
            return values.cpu_moe === undefined && values.n_cpu_moe === undefined;
        });
        assert.match(
            await page.textContent("#command-preview-text"),
            /-ot blk\.\*\.ffn_\.\*_exps\.weight=CUDA0/
        );

        await page.fill("#config-search", "metrics");
        await page.waitForSelector("#flag-metrics", { state: "visible" });
        await page.click("#flag-metrics");
        await page.waitForFunction(() => document.querySelector("#quick-metrics-toggle")?.checked === false);
        await page.click("#flag-metrics");
        await page.waitForFunction(() => document.querySelector("#quick-metrics-toggle")?.checked === true);

        await page.fill("#config-search", "api key");
        await page.waitForSelector("#flag-api_key", { state: "visible" });
        await page.locator("#flag-api_key + .sensitive-input-actions button", { hasText: "Generate" }).click();
        assert.match(await page.inputValue("#flag-api_key"), /^[A-Za-z0-9_-]{43}$/);
        await page.fill("#flag-api_key", "first-secret, second-secret");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().api_key === "first-secret, second-secret");
        const protectedPreview = await page.textContent("#command-preview-text");
        assert.match(protectedPreview, /--api-key <redacted>/);
        assert.ok(!protectedPreview.includes("first-secret"));
        await selectSection(page, "quick-launch");
        assert.equal(await page.inputValue("#quick-api-key"), "first-secret, second-secret");

        await page.evaluate(() => startStatsPolling());
        await page.waitForFunction(() => document.querySelector("#stats-kv-usage")?.textContent === "13%");
        await page.evaluate(() => stopStatsPolling());
        assert.equal(metricsHeaders.at(-1).authorization, "Bearer first-secret");
        assert.equal(slotsHeaders.at(-1).authorization, "Bearer first-secret");

        await selectSection(page, "chat");
        assert.equal(await page.locator("#chat-input").isDisabled(), true);
        assert.equal(await page.locator("#btn-chat-send").isDisabled(), true);
        assert.match(await page.textContent("#chat-no-server-note"), /Start llama-server/i);
        statusRunning = true;
        activeProcessTool = "llama-cli";
        await page.evaluate(() => refreshRuntimeStatusPanels());
        assert.equal(await page.locator("#chat-input").isDisabled(), true);
        activeProcessTool = "llama-server";
        await page.evaluate(() => refreshRuntimeStatusPanels());
        assert.equal(await page.locator("#chat-input").isDisabled(), false);
        await page.evaluate(() => {
            window.LlamaGui.flagCore.setFlagValue("temperature", 0.31);
        });
        await page.waitForFunction(() => document.querySelector("#chat-slider-temp")?.value === "0.31");
        assert.equal(await page.textContent("#chat-val-temp"), "0.31");
        await page.fill("#chat-input", Array(40).fill("line").join("\n"));
        await page.dispatchEvent("#chat-input", "input");
        const chatInputHeight = await page.locator("#chat-input").evaluate((el) => parseFloat(el.style.height));
        assert.ok(chatInputHeight <= 220, "chat textarea auto-resize should respect the 220px cap");
        assert.ok(chatInputHeight > 160, "chat textarea auto-resize should be able to grow beyond the old 160px cap");
        await page.fill("#chat-input", "");
        await page.dispatchEvent("#chat-input", "input");

        assert.equal(await page.locator("#chat-web-search-max-results").getAttribute("min"), "1");
        assert.equal(await page.locator("#chat-web-search-max-results").getAttribute("max"), "10");
        await page.check("#chat-web-search-toggle");
        await page.fill("#chat-web-search-max-results", "7");
        await page.dispatchEvent("#chat-web-search-max-results", "input");
        await page.fill("#chat-input", "Search configurable depth");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("ok"));
        assert.equal(
            await page.evaluate(() => localStorage.getItem("llama_gui_chat_web_search_max_results")),
            "7"
        );
        assert.equal(chatCompletionBodies.at(-1).web_search, true);
        assert.equal(chatCompletionBodies.at(-1).web_search_max_results, 7);
        assert.equal(chatCompletionHeaders.at(-1).authorization, "Bearer first-secret");
        await page.click("#btn-chat-new");

        chatResponseMode = "reasoning-only";
        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("reasoning_format", "deepseek"));
        await page.fill("#chat-input", "Reason only");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector(".chat-reasoning-body")?.textContent.includes("hidden thought"));
        assert.equal(await page.locator(".chat-message.assistant .chat-bubble.hidden").count(), 1);
        const reasoningOnlyMessage = await page.evaluate(() => {
            const conversations = JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]");
            const lastMessage = conversations[0]?.messages?.at(-1);
            return {
                role: lastMessage?.role,
                content: lastMessage?.content,
                reasoning: lastMessage?.reasoning,
                preview: document.querySelector(".chat-history-item-preview")?.textContent || "",
            };
        });
        assert.equal(reasoningOnlyMessage.role, "assistant");
        assert.equal(reasoningOnlyMessage.content, "");
        assert.equal(reasoningOnlyMessage.reasoning, "hidden thought");
        assert.equal(reasoningOnlyMessage.preview, "hidden thought");
        await page.click("#btn-chat-new");

        chatResponseMode = "think-content";
        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("reasoning_format", "none"));
        await page.fill("#chat-input", "Keep raw thinking tags");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("<think>raw thought</think>"));
        assert.equal(await page.locator(".chat-reasoning").count(), 0);
        const rawThinkMessage = await page.evaluate(() => {
            const conversations = JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]");
            const lastMessage = conversations[0]?.messages?.at(-1);
            return {
                content: lastMessage?.content,
                reasoning: lastMessage?.reasoning || "",
            };
        });
        assert.equal(rawThinkMessage.content, "<think>raw thought</think>\nFinal visible");
        assert.equal(rawThinkMessage.reasoning, "");
        chatResponseMode = "ok";
        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("reasoning_format", "auto"));

        await selectSection(page, "quick-launch");
        await setRangeValue(page, "#quick-temperature", "0.42");
        await page.waitForTimeout(250);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.42);
        await page.waitForFunction(() => document.querySelector("#chat-slider-temp")?.value === "0.42");
        await setRangeValue(page, "#quick-temperature", "0.96");
        await setRangeValue(page, "#quick-repeat-penalty", "1.02");
        await setRangeValue(page, "#quick-presence-penalty", "0.3");
        await page.waitForTimeout(250);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.96);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().repeat_penalty === 1.02);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().presence_penalty === 0.3);
        assert.equal(await page.locator("#quick-temperature").evaluate((el) => el.validity.valid), true);
        assert.equal(await page.locator("#quick-repeat-penalty").evaluate((el) => el.validity.valid), true);
        assert.equal(await page.locator("#quick-presence-penalty").evaluate((el) => el.validity.valid), true);
        await selectSection(page, "configure");
        await page.fill("#config-search", "presence");
        await page.waitForSelector("#flag-presence_penalty", { state: "visible" });
        await page.waitForFunction(() => document.querySelector("#flag-presence_penalty")?.value === "0.3");
        assert.equal(await page.locator("#flag-presence_penalty").evaluate((el) => el.step), "0.1");
        assert.equal(await page.locator("#flag-presence_penalty").evaluate((el) => el.validity.valid), true);
        await page.fill("#config-search", "temperature");
        await page.waitForSelector("#flag-temperature", { state: "visible" });
        await page.waitForFunction(() => document.querySelector("#flag-temperature")?.value === "0.96");
        assert.equal(await page.locator("#flag-temperature").evaluate((el) => el.step), "0.01");
        assert.equal(await page.locator("#flag-temperature").evaluate((el) => el.validity.valid), true);

        await page.fill("#config-search", "checkpoint min");
        await page.waitForSelector("#flag-checkpoint_every_n_tokens", { state: "visible" });
        assert.equal(await page.locator("#flag-checkpoint_every_n_tokens").getAttribute("min"), "0");
        await page.fill("#flag-checkpoint_every_n_tokens", "0");
        await page.dispatchEvent("#flag-checkpoint_every_n_tokens", "input");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().checkpoint_every_n_tokens === 0);
        assert.equal(await page.locator("#flag-checkpoint_every_n_tokens").evaluate((el) => el.validity.valid), true);
        assert.match(await page.textContent("#command-preview-text"), /-cms 0/);

        const launchArgs = await page.evaluate(() => window.LlamaGui.flagCore.getLaunchArgs().args.flat());
        assert.ok(launchArgs.includes("-c") && launchArgs.includes("12345"));
        assert.ok(launchArgs.includes("-ngl") && launchArgs.includes("9"));
        assert.ok(launchArgs.includes("--temp") && launchArgs.includes("0.96"));
        assert.ok(launchArgs.includes("--repeat-penalty") && launchArgs.includes("1.02"));
        assert.ok(launchArgs.includes("--presence-penalty") && launchArgs.includes("0.3"));
        assert.ok(launchArgs.includes("-cms") && launchArgs.includes("0"));

        await page.evaluate(() => {
            window.LlamaGui.flagCore.setMultipleFlagValues({
                model_draft: "models/draft-smoke.gguf",
                ctx_size_draft: 4096,
            });
        });
        await page.waitForFunction(() => !window.LlamaGui.flagCore.getLaunchArgs().args.flat().includes("-cd"));

        await selectSection(page, "quick-launch");
        await page.fill("#quick-temperature", "0.64");
        await page.dispatchEvent("#quick-temperature", "input");
        await page.fill("#quick-repeat-penalty", "1.07");
        await page.dispatchEvent("#quick-repeat-penalty", "input");
        await page.fill("#quick-presence-penalty", "0.4");
        await page.dispatchEvent("#quick-presence-penalty", "input");
        await page.waitForTimeout(250);
        await page.fill("#quick-sampler-name", "Smoke Sampler");
        await page.click("#btn-quick-sampler-save");
        await page.waitForFunction(() => {
            const raw = localStorage.getItem("llama_gui_sampler_presets_v1");
            const preset = raw && JSON.parse(raw)["Smoke Sampler"];
            return preset?.temperature === 0.64 && preset?.presence_penalty === 0.4;
        });
        await page.fill("#quick-temperature", "0.91");
        await page.dispatchEvent("#quick-temperature", "input");
        await page.fill("#quick-repeat-penalty", "1.19");
        await page.dispatchEvent("#quick-repeat-penalty", "input");
        await page.fill("#quick-presence-penalty", "0.9");
        await page.dispatchEvent("#quick-presence-penalty", "input");
        await page.waitForTimeout(250);
        await page.selectOption("#quick-sampler-select", "custom|Smoke Sampler");
        await page.click("#btn-quick-sampler-load");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.64);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().presence_penalty === 0.4);
        await page.waitForFunction(() => document.querySelector("#chat-slider-temp")?.value === "0.64");
        await selectSection(page, "configure");
        await page.fill("#config-search", "presence");
        await page.waitForSelector("#flag-presence_penalty", { state: "visible" });
        await page.waitForFunction(() => document.querySelector("#flag-presence_penalty")?.value === "0.4");
        await selectSection(page, "quick-launch");
        await page.selectOption("#quick-sampler-select", "custom|Smoke Sampler");
        const deletePromise = page.waitForFunction(() => {
            const raw = localStorage.getItem("llama_gui_sampler_presets_v1");
            return raw && !Object.prototype.hasOwnProperty.call(JSON.parse(raw), "Smoke Sampler");
        });
        await page.click("#btn-quick-sampler-delete");
        await page.click("#confirm-modal-ok");
        await deletePromise;

        await page.evaluate(() => {
            window.LlamaGui.flagCore.setMultipleFlagValues({
                host: "0.0.0.0",
                port: 9099,
                alias: "smoke-alias",
                api_key: "secret",
            });
            window.LlamaGui.apiTab.updateEndpoints();
        });
        await selectSection(page, "api");
        await page.waitForFunction(() => document.querySelector("#api-base-url")?.textContent === "http://0.0.0.0:9099");
        assert.match(await page.textContent("#api-endpoints-list"), /http:\/\/0\.0\.0\.0:9099\/v1\/chat\/completions/);
        assert.match(await page.textContent("#api-snippets-list"), /smoke-alias/);
        assert.match(await page.textContent("#api-snippets-list"), /Authorization: Bearer YOUR_API_KEY/);

        const tunnelStates = await page.evaluate(() => {
            const readState = () => ({
                badge: document.querySelector("#remote-tunnel-badge")?.textContent,
                badgeClasses: Array.from(document.querySelector("#remote-tunnel-badge")?.classList || []),
                status: document.querySelector("#remote-tunnel-status")?.textContent,
                urlHidden: document.querySelector("#remote-tunnel-url-row")?.classList.contains("hidden"),
                url: document.querySelector("#remote-tunnel-url")?.textContent,
                openAiUrl: document.querySelector("#remote-openai-url")?.textContent,
                startDisabled: document.querySelector("#btn-start-remote-tunnel")?.disabled,
                stopHidden: document.querySelector("#btn-stop-remote-tunnel")?.classList.contains("hidden"),
            });
            const states = {};
            window.LlamaGui.remoteTunnelUi.renderStatus({ status: "idle", message: "Remote tunnel is not running." });
            states.idle = readState();
            window.LlamaGui.remoteTunnelUi.renderStatus({ status: "starting", message: "Starting Cloudflare tunnel..." });
            states.starting = readState();
            window.LlamaGui.remoteTunnelUi.renderStatus({
                status: "running",
                message: "Remote tunnel is running.",
                url: "https://smoke.trycloudflare.com/",
            });
            states.running = readState();
            window.LlamaGui.remoteTunnelUi.renderStatus({ status: "error", message: "Tunnel failed" });
            states.error = readState();
            return states;
        });
        assert.equal(tunnelStates.idle.badge, "idle");
        assert.equal(tunnelStates.idle.urlHidden, true);
        assert.equal(tunnelStates.starting.startDisabled, true);
        assert.equal(tunnelStates.starting.stopHidden, false);
        assert.ok(tunnelStates.starting.badgeClasses.includes("working"));
        assert.equal(tunnelStates.running.urlHidden, false);
        assert.equal(tunnelStates.running.url, "https://smoke.trycloudflare.com/");
        assert.equal(tunnelStates.running.openAiUrl, "https://smoke.trycloudflare.com/v1");
        assert.ok(tunnelStates.running.badgeClasses.includes("running"));
        assert.equal(tunnelStates.error.status, "Tunnel failed");
        assert.ok(tunnelStates.error.badgeClasses.includes("error"));

        await selectSection(page, "configure");
        await page.fill("#custom-launch-args", "--threads 8\n--chat-template-kwargs '{\"preserve_thinking\":true}'");
        await page.dispatchEvent("#custom-launch-args", "input");
        await page.waitForFunction(() => document.querySelector("#command-preview-text")?.textContent.includes("--threads 8"));
        const customState = await page.evaluate(() => ({
            raw: window.LlamaGui.flagCore.getFlagValues().custom_args,
            args: window.LlamaGui.flagCore.getLaunchArgs().args.flat(),
        }));
        assert.equal(customState.raw, "--threads 8\n--chat-template-kwargs '{\"preserve_thinking\":true}'");
        assert.ok(customState.args.includes("--threads") && customState.args.includes("8"));
        assert.ok(customState.args.includes("--chat-template-kwargs"));
        assert.ok(customState.args.includes('{"preserve_thinking":true}'));

        await page.evaluate(() => window.LlamaGui.flagCore.applyFlagValues({ custom_args: "--parallel 4" }));
        await page.waitForFunction(() => document.querySelector("#custom-launch-args")?.value === "--parallel 4");
        assert.match(await page.textContent("#command-preview-text"), /--parallel 4/);

        await page.fill("#custom-launch-args", "--threads 'unterminated");
        await page.dispatchEvent("#custom-launch-args", "input");
        await page.waitForFunction(() => document.querySelector("#custom-launch-args-status")?.textContent.includes("unmatched single quote"));
        assert.match(await page.textContent("#command-preview-text"), /Cannot launch:/);
        await page.selectOption("#model-select", "smoke-model.gguf");
        await page.dispatchEvent("#model-select", "change");
        const launchCountBefore = launchBodies.length;
        await page.click("#btn-launch");
        await page.waitForFunction(() => document.querySelector("#toast-container")?.textContent.includes("unmatched single quote"));
        assert.equal(launchBodies.length, launchCountBefore);

        await selectSection(page, "install");
        pageErrors.length = 0;
        const customReleaseCountBefore = releaseRequests.filter((search) => search.includes("backend=custom")).length;
        await page.selectOption("#backend-select", "custom");
        await page.waitForFunction(() => document.querySelector("#custom-backend-info")?.offsetParent !== null);
        await page.waitForFunction(() => document.querySelector("#btn-install")?.textContent === "Activate Custom");
        await page.waitForTimeout(250);
        assert.equal(releaseRequests.filter((search) => search.includes("backend=custom")).length, customReleaseCountBefore);
        await page.click("#btn-install");
        await page.waitForFunction(() => document.querySelector("#install-status")?.textContent.includes("Custom backend activated"));
        assert.equal(activateCustomRequests.length, 1);
        assert.equal(pageErrors.length, 0, pageErrors.join("\n"));

        await selectSection(page, "quick-launch");
        const initialSidebarSlider = await page.evaluate(() => {
            const panel = document.querySelector("#sidebar-model-switcher");
            const theme = document.querySelector(".theme-switcher");
            const slider = document.querySelector("#sidebar-model-switcher-slider");
            const panelBox = panel.getBoundingClientRect();
            const themeBox = theme.getBoundingClientRect();
            return {
                disabled: slider.getAttribute("aria-disabled"),
                value: slider.getAttribute("aria-valuenow"),
                panelBottom: panelBox.bottom,
                themeTop: themeBox.top,
                footerBottom: document.querySelector(".sidebar-footer").getBoundingClientRect().bottom,
                viewportHeight: window.innerHeight,
            };
        });
        assert.equal(initialSidebarSlider.disabled, "true");
        assert.equal(initialSidebarSlider.value, "0");
        assert.ok(initialSidebarSlider.panelBottom <= initialSidebarSlider.themeTop, "model and theme switchers must not overlap");
        assert.ok(initialSidebarSlider.footerBottom <= initialSidebarSlider.viewportHeight, "sidebar footer must remain in the viewport");

        await page.evaluate(async () => {
            const entries = [
                {
                    name: "Sidebar Model A",
                    full: true,
                    fingerprint: "a".repeat(64),
                    data: { tool: "llama-server", model: "alpha.gguf", flags: {} },
                },
                {
                    name: "Sidebar Model B",
                    full: true,
                    fingerprint: "b".repeat(64),
                    data: { tool: "llama-server", model: "beta.gguf", flags: {} },
                },
            ];
            const activeRuntime = {
                generation: 42,
                tool: "llama-server",
                source: "model-switcher",
                slot: "a",
                preset: "Sidebar Model A",
                model: "alpha.gguf",
                preset_fingerprint: "a".repeat(64),
            };
            window.__sidebarSwitchCalls = 0;
            window.LlamaGui.modelSwitchUi.configure({
                fetchPresetEntries: async () => entries,
                findPresetByName: (list, name) => list.find(entry => entry.name === name) || null,
                getPresetFingerprint: entry => entry.fingerprint || "",
                getLatestBackendStatus: () => ({ running: true, active_runtime: activeRuntime }),
                getLifecycleSnapshot: () => ({
                    phase: "ready",
                    ready: true,
                    busy: false,
                    activeRuntime,
                }),
                switchSlot: async () => {
                    window.__sidebarSwitchCalls += 1;
                    return { ok: false, cancelled: true };
                },
            });
            window.LlamaGui.modelSwitchUi.setAssignment("a", "Sidebar Model A");
            window.LlamaGui.modelSwitchUi.setAssignment("b", "Sidebar Model B");
            await window.LlamaGui.modelSwitchUi.refresh({ reloadPresets: true });
        });
        await page.waitForFunction(() => document.querySelector("#sidebar-model-switcher-slider")?.getAttribute("aria-disabled") === "false");

        await page.click("#sidebar-model-switcher-track", { position: { x: 70, y: 5 } });
        assert.equal(await page.evaluate(() => window.__sidebarSwitchCalls), 0, "track clicks must be inert");

        const sliderBox = await page.locator("#sidebar-model-switcher-slider").boundingBox();
        const thumbBox = await page.locator("#sidebar-model-switcher-thumb").boundingBox();
        assert.ok(sliderBox && thumbBox, "sidebar slider geometry must be measurable");
        const thumbCenterX = thumbBox.x + thumbBox.width / 2;
        const thumbCenterY = thumbBox.y + thumbBox.height / 2;
        await page.mouse.move(thumbCenterX, thumbCenterY);
        await page.mouse.down();
        await page.mouse.move(sliderBox.x + sliderBox.width * 0.58, thumbCenterY, { steps: 4 });
        await page.mouse.up();
        assert.equal(await page.evaluate(() => window.__sidebarSwitchCalls), 0, "a short drag must snap back without switching");

        await page.waitForTimeout(200);
        const snappedThumbBox = await page.locator("#sidebar-model-switcher-thumb").boundingBox();
        assert.ok(snappedThumbBox, "the slider thumb must remain visible after snap-back");
        const snappedThumbCenterX = snappedThumbBox.x + snappedThumbBox.width / 2;
        const snappedThumbCenterY = snappedThumbBox.y + snappedThumbBox.height / 2;
        await page.mouse.move(snappedThumbCenterX, snappedThumbCenterY);
        await page.mouse.down();
        await page.mouse.move(sliderBox.x + sliderBox.width - 2, snappedThumbCenterY, { steps: 6 });
        await page.mouse.up();
        await page.waitForFunction(() => window.__sidebarSwitchCalls === 1);
        await page.waitForFunction(() => document.querySelector("#sidebar-model-switcher-slider")?.getAttribute("aria-valuenow") === "0");

        await page.focus("#sidebar-model-switcher-slider");
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => window.__sidebarSwitchCalls), 1, "an arrow key should preview without switching");
        assert.match(await page.textContent("#sidebar-model-switcher-status"), /Press Enter to switch to Model B/);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.__sidebarSwitchCalls === 2);
        await page.waitForFunction(() => document.querySelector("#sidebar-model-switcher-slider")?.getAttribute("aria-valuenow") === "0");
        assert.equal(pageErrors.length, 0, pageErrors.join("\n"));

        console.log(`flag sync smoke passed on http://127.0.0.1:${port}/`);
    } finally {
        await browser.close().catch(() => {});
        server.kill();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
