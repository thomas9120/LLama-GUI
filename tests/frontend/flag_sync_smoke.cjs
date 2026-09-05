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

    // A spawn failure (python not on PATH, for instance) emits 'error' on the
    // ChildProcess. With no listener Node treats that as an unhandled error and
    // crashes the runner with a bare trace instead of the diagnostic below.
    let spawnError = null;
    server.on("error", (error) => {
        spawnError = error;
    });

    for (let i = 0; i < 40; i += 1) {
        if (spawnError) {
            throw new Error(
                `Could not start the static server with "${python}": ${spawnError.message}`
                + ` (set PYTHON to override)`
            );
        }
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

async function sampleScreenshotPixels(page, screenshot, points) {
    return page.evaluate(async ({ dataUrl, points: samplePoints }) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();

        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);

        return samplePoints.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
    }, {
        dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
        points,
    });
}

function colorDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
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
        const presetSaveBodies = [];
        const modelsDirRequests = [];
        let statusRunning = false;
        let activeProcessTool = "";
        let statusActiveRuntime = null;
        let stopShouldFail = false;
        let externalChatTarget = null;
        let rememberedTarget = null;
        const externalTargetRequests = [];
        let installedBackend = "cpu";
        let modelsDirInfo = {
            models_dir: "models",
            models_arg_root: "models",
            models_dir_is_default: true,
            models_dir_available: true,
            models_dir_error: "",
        };
        let availableModels = [{ name: "smoke-model.gguf", size_mb: 1 }];
        let chatResponseMode = "ok";
        let contextResponseMode = "ok";
        const contextBodies = [];
        let statsMetrics = {
            promptTokens: 0,
            promptSpeed: 0,
            genTokens: 0,
            genSpeed: 0,
            processing: 0,
        };
        const idleStatsSlots = [
            { id: 0, n_ctx: 1000, speculative: false, is_processing: false },
            {
                id: 1,
                n_ctx: 1000,
                speculative: false,
                is_processing: false,
                n_prompt_tokens: 125,
                next_token: { has_next_token: true, n_decoded: 5, n_remain: 875 },
            },
            {
                id: 2,
                n_ctx: 1000,
                speculative: false,
                is_processing: false,
                next_token: [{ n_decoded: 50, n_remain: 950 }],
            },
        ];
        let statsSlots = idleStatsSlots;

        // Monitor tab fixtures.
        const systemStatsRequests = [];
        let systemStatsBody = {
            sampled_at: 1788278400.5,
            interval_seconds: 2.0,
            system: {
                cpu: { available: true, percent: 18.4 },
                memory: { available: true, used_bytes: 12884901888, total_bytes: 34359738368, percent: 37.5 },
                disk: {
                    available: true,
                    path_label: "Application disk",
                    used_bytes: 500000000000,
                    total_bytes: 1000000000000,
                    percent: 50,
                    read_bytes_per_second: 1240000,
                    write_bytes_per_second: 420000,
                },
            },
            gpus: [{
                provider: "nvidia",
                id: "nvidia:uuid:GPU-SMOKE-0001",
                id_persistent: true,
                index: 0,
                name: "Smoke GPU",
                utilization_percent: 42,
                memory_used_bytes: 4000000000,
                memory_total_bytes: 8000000000,
                temperature_c: 55,
            }],
            gpu_setup: [],
        };
        const outputRequests = [];
        let outputQueue = [];
        let outputCursorValue = 0;
        let outputRunningFlag = false;

        page.on("pageerror", (error) => {
            pageErrors.push(error.message || String(error));
        });
        await page.route("**/api/**", async (route) => {
            const url = new URL(route.request().url());
            const pathName = url.pathname;
            if (pathName === "/api/chat/context") {
                const body = JSON.parse(route.request().postData() || "{}");
                contextBodies.push(body);
                if (contextResponseMode === "compaction") {
                    const tokens = Math.ceil(JSON.stringify(body.messages).length / 4);
                    const reserve = body.max_tokens || 0;
                    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
                        status: tokens + reserve > 4096 ? "overflow" : "ok", capacity: 4096,
                        prompt_tokens: tokens, reply_reserve: reserve, reserve_source: "request", remaining: 4096 - tokens - reserve,
                    }) });
                    return;
                }
                await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
                    contextResponseMode === "unavailable" ? { status: "unavailable", message: "Context count unavailable; the server will validate the request." }
                    : contextResponseMode === "warning" ? { status: "warning", capacity: 4096, prompt_tokens: 3600, reply_reserve: 256, reserve_source: "request", remaining: 240 }
                    : { status: "ok", capacity: 4096, prompt_tokens: 100, reply_reserve: 512, reserve_source: "request", remaining: 3484, search_pending: Boolean(body.web_search) }
                ) });
                return;
            }
            if (pathName === "/api/chat/completions") {
                chatCompletionBodies.push(JSON.parse(route.request().postData() || "{}"));
                chatCompletionHeaders.push(route.request().headers());
                let chatStreamBody = [
                    'data: {"choices":[{"delta":{"content":"ok"}}]}',
                    "",
                    "data: [DONE]",
                    "",
                ].join("\n");
                if (chatCompletionBodies.at(-1).gui_require_context) {
                    chatStreamBody = 'data: {"choices":[{"delta":{"content":"The user chose a small interface. <script>literal summary</script> Keep the remaining work visible."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
                } else if (chatResponseMode === "overflow") {
                    chatStreamBody = 'data: {"type":"context_budget","status":"overflow","capacity":4096,"prompt_tokens":4000,"reply_reserve":512,"remaining":-416,"reserve_source":"request","includes_search":true,"message":"Context limit exceeded."}\n\n'
                        + 'data: {"error":{"message":"Context limit exceeded. Shorten the prompt or lower Max Tokens."}}\n\ndata: [DONE]\n\n';
                } else if (chatResponseMode === "failed-partial") {
                    chatStreamBody = 'data: {"choices":[{"delta":{"content":"recoverable partial"}}]}\n\n'
                        + 'data: {"error":{"message":"Test connection failure"}}\n\n';
                } else if (chatResponseMode === "reasoning-only") {
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
                    body: JSON.stringify(availableModels),
                });
                return;
            }
            if (pathName === "/api/select-folder") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ selected: true, path: "D:\\Smoke & Models" }),
                });
                return;
            }
            if (pathName === "/api/models-dir") {
                const body = JSON.parse(route.request().postData() || "{}");
                modelsDirRequests.push(body);
                if (body.path) {
                    modelsDirInfo = {
                        models_dir: body.path,
                        models_arg_root: body.path,
                        models_dir_is_default: false,
                        models_dir_available: true,
                        models_dir_error: "",
                    };
                    availableModels = [{ name: "custom-model.gguf", size_mb: 2 }];
                } else {
                    modelsDirInfo = {
                        models_dir: "models",
                        models_arg_root: "models",
                        models_dir_is_default: true,
                        models_dir_available: true,
                        models_dir_error: "",
                    };
                    availableModels = [{ name: "smoke-model.gguf", size_mb: 1 }];
                }
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(modelsDirInfo),
                });
                return;
            }
            if (pathName === "/api/chat/target") {
                const method = route.request().method();
                const requested = method === "POST" ? JSON.parse(route.request().postData() || "{}") : null;
                externalTargetRequests.push({ method, body: requested });
                if (method === "POST" && requested.restore) {
                    if (rememberedTarget && !rememberedTarget.api_key_required) {
                        externalChatTarget = {
                            connected: true,
                            host: rememberedTarget.host,
                            port: rememberedTarget.port,
                            label: rememberedTarget.label || "",
                            api_key_configured: false,
                        };
                    }
                } else if (method === "POST") {
                    externalChatTarget = {
                        connected: true,
                        host: requested.host,
                        port: Number(requested.port),
                        label: requested.label || "",
                        api_key_configured: Boolean(requested.api_key),
                    };
                    rememberedTarget = {
                        host: requested.host,
                        port: Number(requested.port),
                        label: requested.label || "",
                        api_key_required: Boolean(requested.api_key),
                    };
                } else if (method === "DELETE") {
                    externalChatTarget = null;
                    rememberedTarget = null;
                }
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        external_chat_target: externalChatTarget,
                        remembered_target: rememberedTarget,
                    }),
                });
                return;
            }
            if (pathName === "/api/llama/health") {
                if (statusActiveRuntime) {
                    await route.fulfill({
                        status: 200,
                        contentType: "application/json",
                        body: JSON.stringify({
                            state: "ready",
                            ready: true,
                            generation: statusActiveRuntime.generation,
                        }),
                    });
                } else {
                    await route.fulfill({
                        status: 200,
                        contentType: "application/json",
                        body: JSON.stringify({ state: "starting", ready: false }),
                    });
                }
                return;
            }
            if (pathName === "/api/stop") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ stopped: !stopShouldFail }),
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
                        active_runtime: statusActiveRuntime,
                        external_chat_target: externalChatTarget,
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
                        ...modelsDirInfo,
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
                if (route.request().method() === "POST") {
                    const body = JSON.parse(route.request().postData() || "{}");
                    presetSaveBodies.push(body);
                    await route.fulfill({
                        status: 200,
                        contentType: "application/json",
                        body: JSON.stringify({ saved: true, name: body.name }),
                    });
                    return;
                }
                // Two model groups so the roving focus check below can cross a
                // group boundary and prove collapsed rows are skipped.
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([
                        { name: "smoke-alpha", data: { tool: "llama-server", model: "smoke-model.gguf", flags: {} }, created: 1 },
                        { name: "smoke-beta", data: { tool: "llama-server", model: "smoke-model.gguf", flags: {} }, created: 2 },
                        { name: "smoke-gamma", data: { tool: "llama-server", model: "other-model.gguf", flags: {} }, created: 3 },
                    ]),
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
                    `llamacpp:prompt_tokens_total ${statsMetrics.promptTokens}`,
                    `llamacpp:prompt_tokens_seconds ${statsMetrics.promptSpeed}`,
                    `llamacpp:tokens_predicted_total ${statsMetrics.genTokens}`,
                    `llamacpp:predicted_tokens_seconds ${statsMetrics.genSpeed}`,
                    `llamacpp:requests_processing ${statsMetrics.processing}`,
                ].join("\n"),
            });
        });

        await page.route("**/api/llama/slots**", async (route) => {
            slotsHeaders.push(route.request().headers());
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(statsSlots),
            });
        });

        await page.route("**/api/system-stats**", async (route) => {
            systemStatsRequests.push(route.request().url());
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(systemStatsBody),
            });
        });

        await page.route("**/api/output**", async (route) => {
            outputRequests.push(route.request().url());
            const lines = outputQueue.splice(0);
            outputCursorValue += lines.length;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    lines,
                    next_cursor: outputCursorValue,
                    dropped: false,
                    running: outputRunningFlag,
                    runtime_generation: 0,
                    active_process_tool: "llama-server",
                }),
            });
        });

        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.LlamaGui?.flagCore && window.LlamaGui?.configFlagsUi);
        await page.waitForSelector("#flag-ctx_size", { state: "attached" });

        await page.setInputFiles("#preset-import", {
            name: "smoke-alpha.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({ flags: { temperature: 0.45 } })),
        });
        await page.waitForFunction(() => document.querySelector("#preset-status")?.textContent.includes("already exists"));
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => /already exists/i.test(toast.textContent)));
        assert.equal(presetSaveBodies.length, 0, "a colliding launch preset import must not write");

        await page.setInputFiles("#preset-import", {
            name: "new-import.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({ flags: { temperature: 0.45 } })),
        });
        await page.waitForFunction(() => document.querySelector("#preset-status")?.textContent.includes('Imported preset "new-import"'));
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => toast.textContent.includes('Imported preset "new-import"')));
        assert.equal(presetSaveBodies.length, 1);
        assert.equal(presetSaveBodies[0].name, "new-import");
        assert.equal(presetSaveBodies[0].overwrite, false, "launch preset imports must ask the backend to reject races");

        // The hover gradient must follow the rounded card outline. A previous
        // implementation inset the bar by the full corner radius, leaving a
        // visible straight gap before the curve. Pixel samples keep this tied
        // to the rendered result rather than merely restating the CSS rules.
        await page.evaluate(() => window.LlamaGui.themeUi.applyTheme("nebula"));
        await page.mouse.move(0, 0);
        const modelCard = page.locator(".quick-setup-grid > .card").first();
        const restingCard = await modelCard.screenshot({ animations: "disabled" });
        await modelCard.hover();
        const hoveredCard = await modelCard.screenshot({ animations: "disabled" });
        const samplePoints = [[1, 1], [12, 2], [28, 2]];
        const [restOutside, restCurve] = await sampleScreenshotPixels(page, restingCard, samplePoints);
        const [hoverOutside, hoverCurve, hoverStrip] = await sampleScreenshotPixels(page, hoveredCard, samplePoints);

        assert.ok(
            colorDistance(restCurve, hoverCurve) > 60,
            `hover must reveal the gradient at the card curve: rest=${restCurve}, hover=${hoverCurve}`
        );
        assert.ok(
            colorDistance(hoverCurve, hoverStrip) < 100,
            `gradient must reach the curve without a radius-sized gap: curve=${hoverCurve}, strip=${hoverStrip}`
        );
        assert.ok(
            colorDistance(restOutside, hoverOutside) < 8,
            `gradient must remain clipped out of the rounded corner: rest=${restOutside}, hover=${hoverOutside}`
        );
        await page.mouse.move(0, 0);
        await page.evaluate(() => window.LlamaGui.themeUi.applyTheme("tokyo"));

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

        await page.fill("#quick-context-custom", "1e5");
        await page.dispatchEvent("#quick-context-custom", "input");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().ctx_size === 100000);
        assert.equal(await page.inputValue("#flag-ctx_size"), "100000");

        await page.evaluate(() => {
            const fitCtx = document.getElementById("quick-fit-ctx");
            fitCtx.value = "1e5";
            fitCtx.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().fit_ctx === 100000);

        await page.evaluate(() => {
            window.LlamaGui.flagCore.setMultipleFlagValues({
                chat_template: "phi4",
                chat_template_custom: undefined,
            });
            window.LlamaGui.quickLaunchUi.refresh();
        });
        await page.waitForFunction(() => document.querySelector("#quick-template-pack")?.value === "phi4");
        assert.match(
            await page.locator("#quick-template-pack option:checked").textContent(),
            /phi4.*llama\.cpp built-in/i
        );

        await selectSection(page, "configure");

        // Typed one key at a time on purpose. Every keystroke writes flag state,
        // which loops back into restoreFlagInputs(); when that rewrote el.value
        // unconditionally, type="number" reported the partial "0." as "" and the
        // decimal point was wiped as fast as it was typed. page.fill() sets the
        // value in one shot and would not have caught it.
        await page.fill("#config-search", "temperature");
        await page.waitForSelector("#flag-temperature", { state: "visible" });
        await page.click("#flag-temperature");
        await page.evaluate(() => { document.getElementById("flag-temperature").value = ""; });
        await page.type("#flag-temperature", "0.85");
        assert.equal(
            await page.inputValue("#flag-temperature"),
            "0.85",
            "typing a decimal into a float flag must survive the state round-trip"
        );
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.85);

        // An unrelated flag edit must update mirrored values without replacing
        // the structural option nodes in Quick Launch or Model Switcher.
        const structuralOptionsStayedMounted = await page.evaluate(async () => {
            const quickModelOption = document.querySelector("#quick-model-select option");
            const quickSamplerOption = document.querySelector("#quick-sampler-select option");
            const modelSwitcherOption = document.querySelector("#model-switch-select-a option");
            window.LlamaGui.flagCore.setFlagValue("temperature", 0.84);
            await new Promise(resolve => setTimeout(resolve, 0));
            return {
                quickModel: quickModelOption === document.querySelector("#quick-model-select option"),
                quickSampler: quickSamplerOption === document.querySelector("#quick-sampler-select option"),
                modelSwitcher: modelSwitcherOption === document.querySelector("#model-switch-select-a option"),
            };
        });
        assert.deepEqual(structuralOptionsStayedMounted, {
            quickModel: true,
            quickSampler: true,
            modelSwitcher: true,
        });

        // Trailing zeros are the sharper case: "0.0" parses to 0, so a plain
        // value-equality guard would still rewrite the field to "0" mid-typing.
        await page.evaluate(() => { document.getElementById("flag-temperature").value = ""; });
        await page.type("#flag-temperature", "0.05");
        assert.equal(await page.inputValue("#flag-temperature"), "0.05");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.05);

        // A cleared field must stay cleared rather than snapping back to state.
        await page.fill("#flag-temperature", "");
        assert.equal(await page.inputValue("#flag-temperature"), "");
        await page.fill("#config-search", "");
        await page.waitForSelector("#flag-ctx_size", { state: "visible" });

        await page.evaluate(() => {
            const ctxSize = document.getElementById("flag-ctx_size");
            ctxSize.value = "1e5";
            ctxSize.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().ctx_size === 100000);
        assert.match(await page.textContent("#command-preview-text"), /-c 100000/);

        await page.fill("#config-search", "per-slot context");
        await page.waitForSelector("#flag-kv_unified_per_slot", { state: "visible" });
        assert.equal(await page.locator("#flag-kv_unified_per_slot").getAttribute("min"), "1");
        await page.fill("#flag-kv_unified_per_slot", "16000");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().kv_unified_per_slot === 16000);
        assert.match(await page.textContent("#command-preview-text"), /--kv-unified-per-slot 16000/);
        assert.match(await page.textContent("#command-preview-text"), /-c 100000/);

        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("kv_unified", "disabled"));
        await page.waitForFunction(() => document.querySelector("#flag-kv_unified_per_slot")?.disabled === true);
        assert.doesNotMatch(await page.textContent("#command-preview-text"), /--kv-unified-per-slot/);
        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("kv_unified", "enabled"));
        await page.waitForFunction(() => document.querySelector("#flag-kv_unified_per_slot")?.disabled === false);
        assert.match(await page.textContent("#command-preview-text"), /--kv-unified-per-slot 16000/);

        await page.fill("#flag-kv_unified_per_slot", "");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().kv_unified_per_slot === undefined);
        await page.fill("#config-search", "");
        assert.equal(await page.inputValue("#flag-chat_template"), "phi4");
        await page.evaluate(() => {
            window.LlamaGui.flagCore.setMultipleFlagValues({
                ctx_size: 12345,
                fit_ctx: 12345,
                chat_template: undefined,
            });
            window.LlamaGui.quickLaunchUi.afterApply(window.LlamaGui.flagCore.getFlagValues());
        });
        await page.fill("#config-search", "sampling");
        await page.waitForFunction(() => {
            const headers = Array.from(document.querySelectorAll(
                '.accordion[data-category-id="sampling"] .flag-submenu-header'
            ));
            return headers.length > 0 && headers.every((header) => header.classList.contains("open"));
        });
        await page.selectOption("#tool-select", "llama-cli");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getCurrentTool() === "llama-cli");
        await page.waitForFunction(() => {
            const headers = Array.from(document.querySelectorAll(
                '.accordion[data-category-id="sampling"] .flag-submenu-header'
            ));
            return headers.length > 0 && headers.every((header) => header.classList.contains("open"));
        });
        await page.click("#btn-clear-search");
        await page.waitForFunction(() => document.querySelector("#config-search")?.value === "");
        assert.equal(
            await page.locator(".flag-submenu-header.open").count(),
            0,
            "clearing search after a tool change must not restore submenu state from the previous tool"
        );
        await page.selectOption("#tool-select", "llama-server");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getCurrentTool() === "llama-server");

        await page.fill("#config-search", "default reasoning effort");
        await page.waitForSelector("#flag-chat_template_reasoning_effort", { state: "visible" });
        assert.deepEqual(
            await page.locator("#flag-chat_template_reasoning_effort option").evaluateAll((options) => (
                options.map((option) => option.value)
            )),
            ["auto", "low", "medium", "high", "xhigh"]
        );
        assert.match(
            await page.textContent('.flag-row[data-flag-id="chat_template_reasoning_effort"] .flag-desc'),
            /server-wide/i
        );
        await page.selectOption("#flag-chat_template_reasoning_effort", "xhigh");
        await page.waitForFunction(() => (
            window.LlamaGui.flagCore.getFlagValues().chat_template_reasoning_effort === "xhigh"
        ));
        // Deterministic native path regardless of when /api/status landed.
        await page.evaluate(() => window.LlamaGui.flagCore.setBinaryTag("b10502"));
        let reasoningArgs = await page.evaluate(() => window.LlamaGui.flagCore.getLaunchArgs().args.flat());
        assert.ok(reasoningArgs.includes("--reasoning-effort"));
        assert.ok(reasoningArgs.includes("xhigh"));
        await page.selectOption("#flag-chat_template_reasoning_effort", "auto");
        reasoningArgs = await page.evaluate(() => window.LlamaGui.flagCore.getLaunchArgs().args.flat());
        assert.ok(!reasoningArgs.includes("--reasoning-effort"));
        assert.ok(!reasoningArgs.includes("--chat-template-kwargs"));

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
        const passwordManagerHints = await page.evaluate(() => {
            const fieldState = (id) => {
                const input = document.getElementById(id);
                return {
                    type: input?.type || "",
                    autocomplete: input?.autocomplete || "",
                    maskMode: input?.dataset.sensitiveMaskMode || "",
                    masked: Boolean(input?.classList.contains("sensitive-input-masked")),
                    textSecurity: input ? getComputedStyle(input).webkitTextSecurity : "",
                };
            };
            return {
                cssMasking: Boolean(window.CSS?.supports?.("-webkit-text-security", "disc")),
                searchAutocompletes: Array.from(document.querySelectorAll(".ss-search"))
                    .map((input) => input.autocomplete),
                fields: ["flag-api_key", "quick-api-key", "hf-token-input"].map(fieldState),
            };
        });
        assert.ok(passwordManagerHints.searchAutocompletes.length > 0);
        assert.ok(passwordManagerHints.searchAutocompletes.every((value) => value === "off"));
        for (const field of passwordManagerHints.fields) {
            assert.equal(field.autocomplete, "off");
            assert.equal(field.maskMode, passwordManagerHints.cssMasking ? "css" : "password");
            assert.equal(field.type, passwordManagerHints.cssMasking ? "text" : "password");
            assert.equal(field.masked, passwordManagerHints.cssMasking);
            if (passwordManagerHints.cssMasking) assert.equal(field.textSecurity, "disc");
        }
        await page.locator("#flag-api_key + .sensitive-input-actions button", { hasText: "Generate" }).click();
        assert.match(await page.inputValue("#flag-api_key"), /^[A-Za-z0-9_-]{43}$/);
        const showApiKey = page.locator("#flag-api_key + .sensitive-input-actions button", { hasText: "Show" });
        await showApiKey.click();
        assert.equal(await page.locator("#flag-api_key").getAttribute("type"), "text");
        assert.equal(await page.locator("#flag-api_key").evaluate((input) => input.classList.contains("sensitive-input-masked")), false);
        await page.locator("#flag-api_key + .sensitive-input-actions button", { hasText: "Hide" }).click();
        assert.equal(
            await page.locator("#flag-api_key").getAttribute("type"),
            passwordManagerHints.cssMasking ? "text" : "password"
        );
        assert.equal(
            await page.locator("#flag-api_key").evaluate((input) => input.classList.contains("sensitive-input-masked")),
            passwordManagerHints.cssMasking
        );
        await page.fill("#flag-api_key", "first-secret, second-secret");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().api_key === "first-secret, second-secret");
        const protectedPreview = await page.textContent("#command-preview-text");
        assert.match(protectedPreview, /--api-key <redacted>/);
        assert.ok(!protectedPreview.includes("first-secret"));
        await selectSection(page, "quick-launch");
        assert.equal(await page.inputValue("#quick-api-key"), "first-secret, second-secret");

        statsMetrics = {
            promptTokens: 40,
            promptSpeed: 4,
            genTokens: 20,
            genSpeed: 2,
            processing: 1,
        };
        statsSlots = [{
            id: 1,
            id_task: 1,
            n_ctx: 1000,
            is_processing: true,
            n_prompt_tokens: 60,
            n_prompt_tokens_processed: 40,
            next_token: { n_decoded: 20 },
        }];
        await page.evaluate(async () => {
            startStatsPolling({ generation: 1 }, { operation: "manual-launch" });
            await pollStats();
        });
        assert.equal(await page.textContent("#stats-prompt-tokens"), "40",
            "fresh launches must retain tokens processed before the first stats poll");
        assert.equal(await page.textContent("#stats-gen-tokens"), "20");
        assert.equal(await page.textContent("#stats-context"), "60",
            "Session tokens must sum prompt plus generated since the baseline");
        assert.ok((await page.textContent("#stats-bar")).includes("Session tokens"),
            "the fixed bar labels cumulative tokens as Session tokens, not Context");

        statsMetrics = {
            promptTokens: 1000,
            promptSpeed: 11,
            genTokens: 500,
            genSpeed: 7,
            processing: 0,
        };
        statsSlots = idleStatsSlots;
        await page.evaluate(async () => {
            startStatsPolling({ generation: 2 }, { operation: "restore" });
            await pollStats();
        });
        assert.equal(await page.textContent("#stats-prompt-tokens"), "0",
            "pre-poll chat resets must not expose lifetime prompt counters after reconnect");
        assert.equal(await page.textContent("#stats-gen-tokens"), "0");
        assert.equal(await page.textContent("#stats-context"), "0",
            "a restored target baselines on its first sample, so session tokens start at zero");
        assert.equal(await page.textContent("#stats-kv-usage"), "13%",
            "Context (most-filled slot) must use n_prompt_tokens / n_ctx");

        statsMetrics.processing = 1;
        statsSlots = [{
            id: 1,
            id_task: 77,
            n_ctx: 1000,
            is_processing: true,
            n_prompt_tokens: 110,
            n_prompt_tokens_processed: 100,
            next_token: { n_decoded: 10 },
        }];
        await page.evaluate(() => pollStats());
        await wait(1100);
        statsSlots[0].n_prompt_tokens = 140;
        statsSlots[0].next_token.n_decoded = 40;
        await page.evaluate(() => pollStats());
        const liveGenSpeed = Number(await page.textContent("#stats-gen-speed"));
        assert.ok(liveGenSpeed > 20 && liveGenSpeed < 35,
            `generation speed must use live slot deltas, got ${liveGenSpeed}`);
        assert.equal(await page.textContent("#stats-context"), "0",
            "session tokens stay baseline-relative while slot context moves independently");

        await page.evaluate(() => stopStatsPolling());
        assert.equal(metricsHeaders.at(-1).authorization, "Bearer first-secret");
        assert.equal(slotsHeaders.at(-1).authorization, "Bearer first-secret");

        // A failed Stop leaves the same llama-server alive. Recovery must pass
        // its runtime through startStatsPolling so inference polling resumes.
        statusRunning = true;
        activeProcessTool = "llama-server";
        statusActiveRuntime = { tool: "llama-server", generation: 42 };
        stopShouldFail = true;
        await page.evaluate(async () => {
            await processLifecycle.restore({
                running: true,
                active_process_tool: "llama-server",
                active_runtime: { tool: "llama-server", generation: 42 },
            }, { startOutput: () => {}, postReady: () => {} });
            await stopLlama();
        });
        assert.equal(await page.evaluate(() => inferenceStats.getTargetKey()), "gui:42");
        assert.equal(
            await page.locator("#stats-bar").evaluate((el) => el.classList.contains("hidden")),
            false,
            "failed Stop recovery must keep the fixed stats bar active",
        );
        await page.evaluate(() => stopOutputPolling());
        stopShouldFail = false;
        statusRunning = false;
        activeProcessTool = "";
        statusActiveRuntime = null;
        await page.evaluate(() => stopStatsPolling());
        await page.evaluate(() => refreshRuntimeStatusPanels());

        // A rejected metrics body must not discard a successful slots response.
        const independentSourceSnapshot = await page.evaluate(async () => {
            const originalFetch = window.fetch;
            window.fetch = async (url) => {
                const textUrl = String(url);
                if (textUrl.includes("/api/llama/metrics?")) {
                    return { ok: true, text: async () => { throw new Error("metrics body failed"); } };
                }
                if (textUrl.includes("/api/llama/slots?")) {
                    return {
                        ok: true,
                        json: async () => [{
                            id: 0,
                            id_task: 1,
                            is_processing: false,
                            n_ctx: 1000,
                            n_prompt_tokens: 250,
                        }],
                    };
                }
                return originalFetch(url);
            };
            try {
                startStatsPolling({ generation: 43 }, { operation: "restore" });
                await pollStats();
                return inferenceStats.getSnapshot();
            } finally {
                window.fetch = originalFetch;
                stopStatsPolling();
            }
        });
        assert.equal(independentSourceSnapshot.sources.metrics, "unavailable");
        assert.equal(independentSourceSnapshot.sources.slots, "ok");
        assert.equal(independentSourceSnapshot.context.used, 250);

        await selectSection(page, "chat");
        const chatViewport = page.viewportSize();
        const settingsWereCollapsed = await page.locator("#chat-sidebar").evaluate(el => el.classList.contains("collapsed"));
        for (const width of [1440, 1320, 1217, 1024, 901, 900, 760]) {
            await page.setViewportSize({ width, height: 915 });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            // Exercise layout through the real handlers without earlier test
            // notifications intercepting pointer clicks during resize.
            await page.locator("#btn-collapse-sidebar").evaluate(el => el.click());
            await page.waitForFunction(() => {
                const rect = document.querySelector("#chat-sidebar").getBoundingClientRect();
                return innerWidth > 900 ? rect.width < 1 : rect.height < 1;
            });
            if (width > 900) {
                const gap = await page.evaluate(() => document.querySelector(".chat-layout").getBoundingClientRect().right
                    - document.querySelector("#btn-open-sidebar").getBoundingClientRect().right);
                assert.ok(gap <= 10, `collapsed settings must not reserve panel width at ${width}px (gap ${gap})`);
            }
            await page.locator("#btn-open-sidebar").evaluate(el => el.click());
            await page.waitForFunction(() => document.querySelector("#chat-sidebar").getBoundingClientRect().width > 200);
            if (width <= 900) {
                await page.waitForFunction(() => Math.abs(document.querySelector("#chat-sidebar").getBoundingClientRect().width
                    - document.querySelector(".chat-layout").getBoundingClientRect().width) < 1);
            }
        }
        await page.setViewportSize(chatViewport);
        await page.locator(settingsWereCollapsed ? "#btn-collapse-sidebar" : "#btn-open-sidebar").evaluate(el => el.click());

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
        for (const limit of [-1, 0, 17, 2049, 200000]) {
            await page.evaluate((value) => window.LlamaGui.flagCore.setFlagValue("n_predict", value), limit);
            assert.equal(await page.locator("#chat-slider-max-tokens").inputValue(), String(limit));
            assert.equal(await page.textContent("#chat-val-max-tokens"), limit === -1 ? "Server default" : String(limit));
        }
        await page.locator("#chat-slider-max-tokens").evaluate((el) => {
            el.value = "1025";
            el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        assert.equal(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues().n_predict), 1025);
        assert.equal(await page.textContent("#chat-val-max-tokens"), "1025");
        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("n_predict", -1));
        await page.fill("#chat-input", Array(40).fill("line").join("\n"));
        await page.dispatchEvent("#chat-input", "input");
        const chatInputHeight = await page.locator("#chat-input").evaluate((el) => parseFloat(el.style.height));
        assert.ok(chatInputHeight <= 220, "chat textarea auto-resize should respect the 220px cap");
        assert.ok(chatInputHeight > 160, "chat textarea auto-resize should be able to grow beyond the old 160px cap");
        await page.fill("#chat-input", "");
        await page.dispatchEvent("#chat-input", "input");

        assert.equal(await page.locator("#chat-web-search-max-results").getAttribute("min"), "1");
        assert.equal(await page.locator("#chat-web-search-max-results").getAttribute("max"), "10");
        assert.deepEqual(await page.locator("#chat-thinking-effort option").allTextContents(), [
            "Auto (model default)", "Off", "Low", "Medium", "High", "XHigh",
        ]);
        await page.selectOption("#chat-thinking-effort", "medium");
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
        assert.deepEqual(chatCompletionBodies.at(-1).chat_template_kwargs, {
            enable_thinking: true,
            reasoning_effort: "medium",
        });
        assert.equal(
            await page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]")[0]?.thinkingEffort),
            "medium"
        );
        assert.equal(chatCompletionHeaders.at(-1).authorization, "Bearer first-secret");
        await page.click("#btn-chat-new");
        assert.equal(await page.locator("#chat-thinking-effort").inputValue(), "auto");

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
        chatResponseMode = "ok";
        await page.fill("#chat-input", "Use the earlier reasoning");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("ok"));
        const preservedAssistant = chatCompletionBodies.at(-1).messages.find(message => message.role === "assistant");
        assert.equal(preservedAssistant.reasoning_content, "hidden thought");
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

        await page.click("#btn-chat-new");
        await page.evaluate(() => {
            const originalFetch = window.fetch;
            window.__restoreChatFetch = () => {
                window.fetch = originalFetch;
                delete window.__restoreChatFetch;
            };
            window.fetch = (url, options) => String(url).includes("/api/chat/completions")
                ? Promise.resolve({ ok: true, status: 200, statusText: "OK", body: null })
                : originalFetch(url, options);
        });
        await page.fill("#chat-input", "Empty response");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Response body is empty"));
        assert.equal(await page.locator(".chat-message.assistant").count(), 1);
        assert.equal(await page.locator(".chat-message.assistant .chat-bubble").count(), 1);
        await page.evaluate(() => window.__restoreChatFetch());

        await page.click("#btn-chat-new");
        await page.evaluate(() => {
            const originalFetch = window.fetch;
            window.__restoreChatFetch = () => {
                window.fetch = originalFetch;
                delete window.__restoreChatFetch;
            };
            window.fetch = (url, options = {}) => {
                if (!String(url).includes("/api/chat/completions")) {
                    return originalFetch(url, options);
                }
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(
                            'data: {"choices":[{"delta":{"content":"partial reply"}}]}\n\n'
                        ));
                        options.signal.addEventListener("abort", () => {
                            controller.error(new DOMException("Aborted", "AbortError"));
                        }, { once: true });
                    },
                });
                return Promise.resolve(new Response(stream, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                }));
            };
        });
        await page.fill("#chat-input", "Stop after a partial response");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("partial reply"));
        await page.click("#btn-chat-stop");
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        const stoppedStreamState = await page.evaluate(() => {
            const conversations = JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]");
            const lastMessage = conversations[0]?.messages?.at(-1);
            return {
                role: lastMessage?.role,
                content: lastMessage?.content,
                assistantBubbles: document.querySelectorAll(".chat-message.assistant").length,
            };
        });
        assert.equal(stoppedStreamState.role, "assistant");
        assert.equal(stoppedStreamState.content, "partial reply");
        assert.equal(stoppedStreamState.assistantBubbles, 1);
        await page.click("#btn-chat-undo");
        const stoppedStreamUndoState = await page.evaluate(() => {
            const conversations = JSON.parse(localStorage.getItem("llama_gui_conversations") || "[]");
            return {
                lastRole: conversations[0]?.messages?.at(-1)?.role,
                userBubbles: document.querySelectorAll(".chat-message.user").length,
                assistantBubbles: document.querySelectorAll(".chat-message.assistant").length,
            };
        });
        assert.equal(stoppedStreamUndoState.lastRole, "user");
        assert.equal(stoppedStreamUndoState.userBubbles, 1);
        assert.equal(stoppedStreamUndoState.assistantBubbles, 0);
        await page.evaluate(() => window.__restoreChatFetch());

        await page.click("#btn-chat-new");
        chatResponseMode = "ok";
        await page.fill("#chat-input", "Recovery test");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        const recoveryRequestCount = chatCompletionBodies.length;
        chatResponseMode = "failed-partial";
        await page.fill("#chat-input", "Keep this draft");
        await page.click("#btn-chat-regenerate");
        await page.waitForFunction(() => document.querySelector(".chat-response-status")?.textContent.includes("previous answer kept"));
        assert.equal(await page.locator(".chat-message.assistant .chat-bubble").innerText(), "ok");
        assert.equal(await page.locator(".chat-message.user").count(), 1);
        assert.equal(await page.locator("#chat-input").inputValue(), "Keep this draft");
        await page.getByRole("button", { name: "Next answer", exact: true }).click();
        assert.equal(await page.locator(".chat-message.assistant .chat-bubble").innerText(), "recoverable partial");
        assert.match(await page.locator(".chat-response-status").innerText(), /Incomplete/);
        await page.getByRole("button", { name: "Previous answer", exact: true }).click();
        chatResponseMode = "ok";
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".chat-response-footer")?.textContent.includes("Answer 3 of 3"));
        assert.equal(await page.locator(".chat-message.user").count(), 1);
        assert.equal(chatCompletionBodies.length, recoveryRequestCount + 2);
        assert.deepEqual(chatCompletionBodies.at(-1).messages, [{ role: "user", content: "Recovery test" }]);
        const recoveredVersions = await page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations"))[0].messages[1].versions);
        assert.equal(recoveredVersions[1].content, "recoverable partial");
        assert.equal(recoveredVersions[1].status, "failed");

        await page.click("#btn-chat-new");
        await page.fill("#chat-input", "Measure my draft");
        await page.waitForFunction(() => document.querySelector("#chat-context-label")?.textContent.includes("4,096"));
        assert.equal(contextBodies.at(-1).messages.at(-1).content, "Measure my draft");
        assert.equal(await page.locator("#chat-context-label").isVisible(), false, "routine context details stay hidden");
        assert.equal(await page.locator("#chat-context-warning").isVisible(), false);
        await page.click("#btn-chat-tools");
        await page.locator("#chat-context-details summary").press("Enter");
        assert.equal(await page.locator("#chat-context-label").isVisible(), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#chat-tools").isVisible(), false);
        assert.equal(await page.locator("#btn-chat-tools").evaluate(el => el === document.activeElement), true);
        await page.click("#btn-chat-tools");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.locator("#chat-tools").isVisible(), false, "tabbing past the trigger dismisses tools");
        await page.click("#btn-chat-tools");
        await page.locator("#chat-messages").click({ position: { x: 5, y: 5 } });
        assert.equal(await page.locator("#chat-tools").isVisible(), false, "outside clicks dismiss tools");

        assert.equal(await page.locator("#chat-context-bar").getAttribute("aria-valuenow"), "15");
        assert.ok(await page.locator("#chat-context-prompt").evaluate(el => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)"));
        chatResponseMode = "overflow";
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector(".chat-response-status")?.textContent.includes("Context limit exceeded"));
        assert.equal(await page.locator("#chat-context-warning").isVisible(), true);
        assert.match(await page.locator("#chat-context-warning").innerText(), /exceeds/);
        await page.click("#btn-chat-context-details");
        assert.equal(await page.locator("#chat-context-label").isVisible(), true);
        assert.match(await page.locator("#chat-context-label").innerText(), /Includes web results/);
        assert.equal(await page.locator("#chat-context-bar").getAttribute("data-status"), "overflow");
        assert.equal(await page.locator(".chat-message.user").innerText(), "U\nMeasure my draft");
        contextResponseMode = "unavailable";
        await page.fill("#chat-input", "Changed draft");
        await page.waitForFunction(() => document.querySelector("#chat-context-label")?.textContent.includes("unavailable"));
        assert.equal(await page.locator("#chat-context-bar").isVisible(), false);
        assert.equal(await page.locator("#chat-context-warning").isVisible(), false);
        assert.equal(await page.locator("#chat-tools").isVisible(), false, "leaving the menu returns space to chat");
        assert.equal(await page.locator("#btn-chat-send").isEnabled(), true);
        contextResponseMode = "warning";
        await page.fill("#chat-input", "Nearly full draft");
        await page.waitForFunction(() => !document.querySelector("#chat-context-warning").hidden);
        assert.match(await page.locator("#chat-context-warning").innerText(), /nearly full/);
        assert.equal(await page.locator("#chat-context-label").isVisible(), false);
        chatResponseMode = "ok";
        contextResponseMode = "ok";
        await page.fill("#chat-input", "Changed draft");
        await page.waitForFunction(() => document.querySelector("#chat-context-warning").hidden);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        assert.equal(chatCompletionBodies.at(-1).messages.filter(msg => msg.role === "user").length, 1);
        assert.equal(await page.locator("#chat-input").inputValue(), "Changed draft");

        // Context and compaction are reached through the composer tools menu;
        // both it and the summary stay collapsed until requested.
        contextResponseMode = "compaction";
        await page.click("#btn-chat-new");
        assert.equal(await page.locator("#btn-chat-compact").isVisible(), false);
        await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("n_predict", 512));
        for (const message of ["Earlier decisions ".repeat(180), "Keep this recent question", "Keep this newest question"]) {
            await page.fill("#chat-input", message);
            await page.click("#btn-chat-send");
            await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        }
        await page.fill("#chat-input", "Draft survives compaction");
        const transcriptBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations"))[0].messages);
        await page.click("#btn-chat-tools");
        await page.click("#btn-chat-compact");
        await page.waitForSelector(".chat-compaction-marker");
        assert.equal(await page.locator(".chat-compaction-marker").getAttribute("open"), null);
        assert.equal(await page.locator(".chat-message").count(), transcriptBefore.length);
        assert.equal(await page.locator("#chat-input").inputValue(), "Draft survives compaction");
        assert.equal(await page.locator("#btn-chat-compact").isDisabled(), true, "compaction needs more turns before running again");
        await page.click("#btn-chat-view-summary");
        assert.equal(await page.locator("#chat-tools").isVisible(), false);
        assert.equal(await page.locator(".chat-compaction-marker").getAttribute("open"), "");
        assert.match(await page.locator(".chat-compaction-marker pre").innerText(), /<script>literal summary<\/script>/);
        assert.equal(await page.locator(".chat-compaction-marker script").count(), 0);
        await page.setViewportSize({ width: 760, height: 800 });
        await page.click("#btn-chat-tools");
        await page.locator("#chat-context-details summary").click();
        const compactLayout = await page.locator("#chat-tools").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
        assert.ok(compactLayout.scroll <= compactLayout.width + 1, "context controls fit a narrow chat");
        assert.ok(compactLayout.left >= 0 && compactLayout.right <= 760, "tools stay within the viewport");
        await page.click("#btn-chat-tools-undo-compaction");
        assert.equal(await page.locator(".chat-compaction-marker").count(), 0);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations"))[0].messages), transcriptBefore);
        await page.setViewportSize({ width: 1440, height: 1000 });
        contextResponseMode = "ok";
        await page.click("#btn-chat-new");

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

        await page.fill("#flag-temperature", "");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === undefined);
        await selectSection(page, "quick-launch");
        assert.equal(await page.textContent("#quick-temperature-value"), "—");
        assert.equal(await page.locator("#quick-temperature").getAttribute("data-unset"), "true");
        assert.ok(!(await page.textContent("#quick-command-preview")).includes("--temp"));
        await setRangeValue(page, "#quick-temperature", "0.96");
        await page.waitForTimeout(250);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.96);
        assert.equal(await page.locator("#quick-temperature").getAttribute("data-unset"), "false");
        await selectSection(page, "configure");

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
        await setRangeValue(page, "#quick-temperature", "0.64");
        await setRangeValue(page, "#quick-repeat-penalty", "1.07");
        await setRangeValue(page, "#quick-presence-penalty", "0.4");
        await page.waitForTimeout(250);
        await page.fill("#quick-sampler-name", "Smoke Sampler");
        await page.click("#btn-quick-sampler-save");
        await page.waitForFunction(() => {
            const raw = localStorage.getItem("llama_gui_sampler_presets_v1");
            const preset = raw && JSON.parse(raw)["Smoke Sampler"];
            return preset?.temperature === 0.64 && preset?.presence_penalty === 0.4;
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => toast.textContent.includes('Saved sampler preset "Smoke Sampler"')));
        await setRangeValue(page, "#quick-temperature", "0.11");
        await page.fill("#quick-sampler-name", "smoke sampler");
        await page.click("#btn-quick-sampler-save");
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => /already exists/i.test(toast.textContent)));
        const samplerStoreAfterCollision = await page.evaluate(
            () => JSON.parse(localStorage.getItem("llama_gui_sampler_presets_v1") || "{}")
        );
        assert.deepEqual(Object.keys(samplerStoreAfterCollision), ["Smoke Sampler"]);
        assert.equal(samplerStoreAfterCollision["Smoke Sampler"].temperature, 0.64);
        assert.equal(samplerStoreAfterCollision["Smoke Sampler"].presence_penalty, 0.4);
        await setRangeValue(page, "#quick-temperature", "0.91");
        await setRangeValue(page, "#quick-repeat-penalty", "1.19");
        await setRangeValue(page, "#quick-presence-penalty", "0.9");
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

        // --- Configure sampler preset: sticky selection + rename ------------
        // Only a real browser can prove these: renderFlags() destroys and rebuilds
        // the sampler panel, so the <select> the assertions run against is a
        // different element than the one that was clicked.
        const configSamplerSelect = ".sampler-presets select";
        await page.selectOption(configSamplerSelect, "custom|Smoke Sampler");
        await page.dispatchEvent(configSamplerSelect, "change");
        // "Smoke Sampler" sorts last, so a reset would fall back to a built-in
        // and this check would be meaningless if it happened to sort first.
        assert.equal(
            await page.$$eval(`${configSamplerSelect} option`, (options) => options[1]?.value),
            "builtin|Balanced",
            "the sampler dropdown must not already be on the preset under test"
        );

        // Tag the current element so the wait proves a rebuild actually happened,
        // rather than passing because the search never re-rendered.
        await page.evaluate((selector) => {
            document.querySelector(selector).dataset.smokeRebuildTag = "1";
        }, configSamplerSelect);
        await page.fill("#config-search", "penalty");
        await page.waitForFunction(
            (selector) => {
                const select = document.querySelector(selector);
                return select && select.dataset.smokeRebuildTag !== "1";
            },
            configSamplerSelect
        );
        assert.equal(
            await page.inputValue(configSamplerSelect),
            "custom|Smoke Sampler",
            "the Configure sampler selection must survive a panel rebuild"
        );

        await page.locator(".sampler-presets button", { hasText: "Rename" }).click();
        await page.waitForSelector("#prompt-modal:not(.hidden)");
        await page.fill("#prompt-modal-input", "Renamed Smoke Sampler");
        await page.click("#prompt-modal-ok");
        await page.waitForFunction(() => {
            const raw = localStorage.getItem("llama_gui_sampler_presets_v1");
            if (!raw) return false;
            const store = JSON.parse(raw);
            return Object.prototype.hasOwnProperty.call(store, "Renamed Smoke Sampler")
                && !Object.prototype.hasOwnProperty.call(store, "Smoke Sampler");
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => toast.textContent.includes('Renamed sampler preset to "Renamed Smoke Sampler"')));
        assert.equal(
            await page.inputValue(configSamplerSelect),
            "custom|Renamed Smoke Sampler",
            "Configure must follow the renamed preset"
        );
        // The mirrored Quick Launch dropdown must follow too, not fall back to
        // the placeholder because the old value string vanished. Read it through
        // evaluate: that section is hidden while Configure is showing.
        assert.equal(
            await page.evaluate(() => document.querySelector("#quick-sampler-select")?.value),
            "custom|Renamed Smoke Sampler",
            "Quick Launch must follow a rename made from Configure"
        );

        // A built-in is not renameable, and the attempt must not disturb the store.
        await page.selectOption(configSamplerSelect, "builtin|Balanced");
        await page.dispatchEvent(configSamplerSelect, "change");
        await page.locator(".sampler-presets button", { hasText: "Rename" }).click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => toast.textContent.includes("Built-in sampler presets cannot be renamed.")));
        assert.equal(
            await page.evaluate(() => document.querySelector("#prompt-modal")?.classList.contains("hidden")),
            true,
            "renaming a built-in must be refused before the prompt opens"
        );
        assert.deepEqual(
            await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("llama_gui_sampler_presets_v1") || "{}"))),
            ["Renamed Smoke Sampler"],
            "a refused rename must leave the sampler store untouched"
        );

        await page.setInputFiles('.sampler-presets input[type="file"]', {
            name: "samplers.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({
                presets: {
                    "Would Be Partial": { temperature: 0.2 },
                    balanced: { temperature: 0.1 },
                },
            })),
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => /already exists/i.test(toast.textContent)));
        assert.deepEqual(
            await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("llama_gui_sampler_presets_v1") || "{}"))),
            ["Renamed Smoke Sampler"],
            "a colliding sampler import must reject the entire batch before writing"
        );

        await page.setInputFiles('.sampler-presets input[type="file"]', {
            name: "malformed-samplers.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({
                presets: {
                    "Would Also Be Partial": { temperature: 0.3 },
                    Broken: "not an object",
                },
            })),
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => /must contain an object of sampler values/i.test(toast.textContent)));
        assert.deepEqual(
            await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("llama_gui_sampler_presets_v1") || "{}"))),
            ["Renamed Smoke Sampler"],
            "a malformed sampler import must reject the entire batch before writing"
        );

        // A rename made from Quick Launch must carry the Configure panel's
        // remembered selection too (the reverse direction of the check above).
        await page.selectOption(configSamplerSelect, "custom|Renamed Smoke Sampler");
        await page.dispatchEvent(configSamplerSelect, "change");
        await selectSection(page, "quick-launch");
        await page.selectOption("#quick-sampler-select", "custom|Renamed Smoke Sampler");
        await page.click("#btn-quick-sampler-rename");
        await page.waitForSelector("#prompt-modal:not(.hidden)");
        await page.fill("#prompt-modal-input", "Renamed Again Sampler");
        await page.click("#prompt-modal-ok");
        await page.waitForFunction(() => {
            const raw = localStorage.getItem("llama_gui_sampler_presets_v1");
            return raw && Object.prototype.hasOwnProperty.call(JSON.parse(raw), "Renamed Again Sampler");
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => toast.textContent.includes('Renamed sampler preset to "Renamed Again Sampler"')));
        await selectSection(page, "configure");
        assert.equal(
            await page.inputValue(configSamplerSelect),
            "custom|Renamed Again Sampler",
            "Configure must follow a rename made from Quick Launch"
        );

        await selectSection(page, "quick-launch");
        await page.selectOption("#quick-sampler-select", "custom|Renamed Again Sampler");
        const deletePromise = page.waitForFunction(() => {
            const raw = localStorage.getItem("llama_gui_sampler_presets_v1");
            return raw && !Object.prototype.hasOwnProperty.call(JSON.parse(raw), "Renamed Again Sampler");
        });
        await page.click("#btn-quick-sampler-delete");
        await page.click("#confirm-modal-ok");
        await deletePromise;
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".toast-message"))
            .some((toast) => toast.textContent.includes('Deleted sampler preset "Renamed Again Sampler"')));

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

        // Connecting to a llama-server this GUI did not launch must unlock Chat
        // on its own, with no process running.
        statusRunning = false;
        activeProcessTool = "";
        await page.evaluate(() => refreshRuntimeStatusPanels());
        assert.equal(await page.textContent("#external-server-badge"), "Not connected");
        assert.equal(
            await page.locator("#external-server-summary").evaluate((el) => el.classList.contains("hidden")),
            true
        );

        await page.fill("#external-server-host", "127.0.0.1");
        await page.fill("#external-server-port", "9001");
        await page.fill("#external-server-key", "external-secret");
        await page.click("#btn-connect-external-server");
        await page.waitForFunction(
            () => document.querySelector("#external-server-badge")?.textContent === "Connected"
        );
        assert.deepEqual(externalTargetRequests.at(-1), {
            method: "POST",
            body: { host: "127.0.0.1", port: "9001", api_key: "external-secret" },
        });
        assert.equal(await page.textContent("#external-server-target"), "127.0.0.1:9001");
        assert.equal(
            await page.locator("#btn-disconnect-external-server").evaluate((el) => el.classList.contains("hidden")),
            false
        );
        assert.match(await page.textContent("#api-status-note"), /started outside this GUI/);

        await selectSection(page, "chat");
        await page.waitForFunction(() => document.querySelector("#chat-input")?.disabled === false);
        assert.equal(await page.locator("#btn-chat-send").isDisabled(), false);

        await selectSection(page, "api");
        await page.click("#btn-disconnect-external-server");
        await page.waitForFunction(
            () => document.querySelector("#external-server-badge")?.textContent === "Not connected"
        );
        assert.equal(externalTargetRequests.at(-1).method, "DELETE");
        assert.equal(await page.inputValue("#external-server-key"), "");
        assert.equal(rememberedTarget, null, "disconnecting must also forget the saved address");

        await selectSection(page, "chat");
        await page.waitForFunction(() => document.querySelector("#chat-input")?.disabled === true);
        await selectSection(page, "api");

        // A keyless address saved by an earlier session reconnects by itself.
        rememberedTarget = { host: "127.0.0.1", port: 9002, label: "Saved", api_key_required: false };
        await page.fill("#external-server-host", "");
        await page.fill("#external-server-port", "");
        await page.evaluate(() => window.LlamaGui.externalServerUi.restore());
        await page.waitForFunction(
            () => document.querySelector("#external-server-badge")?.textContent === "Connected"
        );
        assert.deepEqual(externalTargetRequests.at(-1), { method: "POST", body: { restore: true } });
        assert.equal(await page.inputValue("#external-server-host"), "127.0.0.1");
        assert.equal(await page.inputValue("#external-server-port"), "9002");
        assert.equal(
            await page.textContent("#external-server-note"),
            "Reconnected to Saved (127.0.0.1:9002)."
        );

        // Reload with an already-connected external target. The accepted
        // initial status path must seed inference exactly once without a new
        // external revision or a duplicate reset.
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.LlamaGui?.flagCore && window.LlamaGui?.monitorUi);
        await page.waitForFunction(() => typeof inferenceStats !== "undefined"
            && inferenceStats.getTargetKey() === "ext:0:127.0.0.1:9002");
        assert.equal(await page.evaluate(() => externalTargetRevision), 0,
            "an already-active target must not mint a new external revision");
        assert.equal(
            await page.locator("#stats-bar").evaluate((el) => el.classList.contains("hidden")),
            false,
            "an already-connected external target must restore inference polling",
        );

        // One that needed a key is prefilled and explained, never auto-connected.
        externalChatTarget = null;
        rememberedTarget = { host: "127.0.0.1", port: 9003, label: "", api_key_required: true };
        await page.evaluate(() => refreshRuntimeStatusPanels());
        const requestsBeforeKeyedRestore = externalTargetRequests.length;
        await page.evaluate(() => window.LlamaGui.externalServerUi.restore());
        assert.equal(
            externalTargetRequests.length,
            requestsBeforeKeyedRestore + 1,
            "a key-protected address must only be read, never reconnected"
        );
        assert.equal(externalTargetRequests.at(-1).method, "GET");
        assert.equal(await page.inputValue("#external-server-port"), "9003");
        assert.equal(
            await page.textContent("#external-server-note"),
            "Re-enter the API key for 127.0.0.1:9003 to reconnect."
        );
        assert.equal(await page.textContent("#external-server-badge"), "Not connected");
        rememberedTarget = null;

        await selectSection(page, "configure");
        await page.selectOption("#model-select", "");
        await page.dispatchEvent("#model-select", "change");
        await page.evaluate(() => {
            window.LlamaGui.flagCore.setCurrentTool("llama-server");
            window.LlamaGui.flagCore.setMultipleFlagValues({
                hf_repo: "smoke/remote-model",
                api_key: undefined,
                custom_args: "--api-key one-off-smoke-key",
            });
        });
        await selectSection(page, "quick-launch");
        await page.waitForFunction(() => document.querySelector("#quick-chip-model .chip-text")?.textContent === "Model: remote source");
        assert.ok((await page.locator("#quick-chip-model").getAttribute("class")).includes("ok"));
        assert.equal(await page.textContent("#quick-chip-api .chip-text"), "API: protected");
        assert.ok((await page.locator("#quick-api-protected-badge").getAttribute("class")).includes("visible"));

        await page.evaluate(() => window.LlamaGui.flagCore.setCurrentTool("llama-cli"));
        await page.waitForFunction(() => document.querySelector("#quick-chip-api .chip-text")?.textContent === "API: not applicable");
        assert.ok(!(await page.locator("#quick-api-protected-badge").getAttribute("class")).includes("visible"));

        await page.evaluate(() => {
            window.LlamaGui.flagCore.setCurrentTool("llama-server");
            window.LlamaGui.flagCore.setMultipleFlagValues({
                hf_repo: undefined,
                custom_args: undefined,
            });
        });
        await selectSection(page, "configure");
        await page.selectOption("#model-select", "smoke-model.gguf");
        await page.dispatchEvent("#model-select", "change");
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
        await selectSection(page, "quick-launch");
        assert.ok((await page.locator("#quick-chip-model").getAttribute("class")).includes("ok"));
        assert.equal(await page.textContent("#quick-chip-model .chip-text"), "Model: smoke-model.gguf");
        await selectSection(page, "configure");
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
        await page.setViewportSize({ width: 1346, height: 674 });
        const initialSidebarSlider = await page.evaluate(() => {
            const sidebar = document.querySelector("#sidebar");
            const nav = document.querySelector(".sidebar-nav");
            const panel = document.querySelector("#sidebar-model-switcher");
            const theme = document.querySelector(".theme-menu");
            const slider = document.querySelector("#sidebar-model-switcher-slider");
            const actionsBox = document.querySelector(".sidebar-runtime-actions").getBoundingClientRect();
            const memoryBox = document.querySelector("#sidebar-memory-estimate").getBoundingClientRect();
            const sidebarBox = sidebar.getBoundingClientRect();
            const panelBox = panel.getBoundingClientRect();
            const themeBox = theme.getBoundingClientRect();
            return {
                disabled: slider.getAttribute("aria-disabled"),
                value: slider.getAttribute("aria-valuenow"),
                panelBottom: panelBox.bottom,
                themeTop: themeBox.top,
                footerBottom: document.querySelector(".sidebar-footer").getBoundingClientRect().bottom,
                viewportHeight: window.innerHeight,
                actionsContained: actionsBox.right <= sidebarBox.right,
                memoryContained: memoryBox.right <= sidebarBox.right,
                navFits: nav.scrollHeight <= nav.clientHeight,
            };
        });
        assert.equal(initialSidebarSlider.disabled, "true");
        assert.equal(initialSidebarSlider.value, "0");
        assert.ok(initialSidebarSlider.panelBottom <= initialSidebarSlider.themeTop, "model and theme switchers must not overlap");
        assert.ok(initialSidebarSlider.footerBottom <= initialSidebarSlider.viewportHeight, "sidebar footer must remain in the viewport");
        assert.equal(initialSidebarSlider.actionsContained, true, "runtime buttons must stay inside the sidebar");
        assert.equal(initialSidebarSlider.memoryContained, true, "memory estimate must stay inside the sidebar");
        assert.equal(initialSidebarSlider.navFits, true, "sidebar navigation should fit without scrolling at 1346x674");
        await page.setViewportSize({ width: 1280, height: 720 });

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
            window.__modelSwitcherFetchCalls = 0;
            window.__modelSwitcherEntries = entries;
            window.LlamaGui.modelSwitchUi.configure({
                fetchPresetEntries: async () => {
                    window.__modelSwitcherFetchCalls += 1;
                    return window.__modelSwitcherEntries;
                },
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

        await page.click("#model-switch-toggle");
        const initialModelSwitcherFetchCalls = await page.evaluate(() => window.__modelSwitcherFetchCalls);
        await page.evaluate(() => {
            window.__modelSwitcherEntries.push({
                name: "Refreshed from A",
                full: true,
                fingerprint: "c".repeat(64),
                data: { tool: "llama-server", model: "gamma.gguf", flags: {} },
            });
        });
        await page.click("#model-switch-refresh-a");
        await page.waitForFunction(() => Array.from(document.querySelector("#model-switch-select-b")?.options || [])
            .some(option => option.value === "Refreshed from A"));
        assert.equal(
            await page.evaluate(() => window.__modelSwitcherFetchCalls),
            initialModelSwitcherFetchCalls + 1,
            "Model A refresh should force exactly one preset reload"
        );
        assert.deepEqual(
            await page.evaluate(() => [
                document.querySelector("#model-switch-select-a")?.value,
                document.querySelector("#model-switch-select-b")?.value,
            ]),
            ["Sidebar Model A", "Sidebar Model B"],
            "refreshing presets must preserve both slot assignments"
        );

        await page.evaluate(() => {
            window.__modelSwitcherEntries.push({
                name: "Refreshed from B",
                full: true,
                fingerprint: "d".repeat(64),
                data: { tool: "llama-server", model: "delta.gguf", flags: {} },
            });
        });
        await page.click("#model-switch-refresh-b");
        await page.waitForFunction(() => Array.from(document.querySelector("#model-switch-select-a")?.options || [])
            .some(option => option.value === "Refreshed from B"));

        await page.evaluate(() => {
            const select = document.querySelector("#model-switch-select-a");
            for (let i = 0; i < 20; i += 1) {
                const option = document.createElement("option");
                option.value = `layout-check-${i}`;
                option.textContent = `Layout check preset ${i}`;
                select.appendChild(option);
            }
        });
        await page.click("#model-switch-select-a + .ss-wrap .ss-button");
        await page.waitForSelector(".ss-popup:not(.hidden) .ss-item");
        const searchableSelectAccessibility = await page.evaluate(() => {
            const select = document.querySelector("#model-switch-select-a");
            const button = select?.nextElementSibling?.querySelector(".ss-button");
            const search = document.querySelector(".ss-popup:not(.hidden) .ss-search");
            const activeId = search?.getAttribute("aria-activedescendant") || "";
            const quickSelect = document.querySelector("#quick-model-select");
            const quickButton = quickSelect?.nextElementSibling?.querySelector(".ss-button");
            const quickLabel = quickButton ? document.querySelector(`label[for="${quickButton.id}"]`) : null;
            return {
                buttonLabel: button?.getAttribute("aria-label") || "",
                activeId,
                activeOptionExists: Boolean(activeId && document.getElementById(activeId)),
                quickButtonLabel: quickButton?.getAttribute("aria-label") || "",
                quickLabelText: quickLabel?.textContent?.trim() || "",
            };
        });
        assert.match(searchableSelectAccessibility.buttonLabel, /^Model A preset:/);
        assert.ok(searchableSelectAccessibility.activeOptionExists, "active searchable option must be exposed to assistive technology");
        assert.match(searchableSelectAccessibility.quickButtonLabel, /^Model:/);
        assert.equal(searchableSelectAccessibility.quickLabelText, "Model");
        const searchableOptionLayout = await page.evaluate(() => {
            const item = document.querySelector(".ss-popup:not(.hidden) .ss-item");
            const style = getComputedStyle(item);
            return {
                height: item.getBoundingClientRect().height,
                contentHeight: parseFloat(style.lineHeight)
                    + parseFloat(style.paddingTop)
                    + parseFloat(style.paddingBottom),
            };
        });
        assert.ok(
            searchableOptionLayout.height >= searchableOptionLayout.contentHeight - 1,
            "searchable preset options must retain enough height to render a full text line"
        );
        await page.keyboard.press("Escape");

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
        // --- Presets: roving arrow-key focus -------------------------------
        // Only a real browser can prove the tab order, which is the whole point
        // of the change: the list must be one stop to enter, not one per row.
        await selectSection(page, "presets");
        await page.waitForSelector("#presets-list .preset-group-header");

        const listState = () => page.evaluate(() => {
            const list = document.getElementById("presets-list");
            const items = Array.from(list.querySelectorAll(".preset-group-header, .preset-item"));
            const visible = items.filter((el) => el.offsetParent !== null);
            return {
                tabbable: visible.filter((el) => el.tabIndex === 0).length,
                // Anything inside the list still reachable by Tab.
                tabbableDescendants: Array.from(list.querySelectorAll("input, button"))
                    .filter((el) => el.tabIndex === 0 && el.offsetParent !== null).length,
                focusKey: document.activeElement
                    && (document.activeElement.getAttribute("data-preset-name")
                        || document.activeElement.getAttribute("data-group-key")),
            };
        });

        // Groups collapse by default, so only headers are focusable at first.
        let state = await listState();
        assert.equal(state.tabbable, 1, "the whole preset list must be a single tab stop");

        // Read the rendered order rather than assuming it: groups sort by label,
        // so the mock's models do not appear in the order they were declared.
        const headerKeys = await page.evaluate(() => Array.from(
            document.querySelectorAll("#presets-list .preset-group-header")
        ).map((el) => el.getAttribute("data-group-key")));
        assert.equal(headerKeys.length, 2, "the mock presets should render two model groups");

        await page.locator("#presets-list .preset-group-header").first().focus();
        await page.keyboard.press("ArrowDown");
        state = await listState();
        assert.equal(
            state.focusKey,
            headerKeys[1],
            "with groups collapsed, ArrowDown must skip hidden rows and land on the next header"
        );

        // Expanding a group brings its rows into the sequence.
        await page.locator("#presets-list .preset-group-header").first().focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => {
            const group = document.querySelector("#presets-list .preset-group");
            return group && !group.classList.contains("collapsed");
        });
        const firstRowName = await page.evaluate(() => {
            const group = document.querySelector("#presets-list .preset-group");
            const row = group && group.querySelector(".preset-item");
            return row && row.getAttribute("data-preset-name");
        });

        await page.locator("#presets-list .preset-group-header").first().focus();
        await page.keyboard.press("ArrowDown");
        state = await listState();
        assert.equal(
            state.focusKey,
            firstRowName,
            "ArrowDown into an expanded group must land on its first row"
        );
        assert.equal(state.tabbable, 1, "still exactly one item in the tab order after moving");
        assert.equal(
            state.tabbableDescendants,
            4,
            "only the focused row's checkbox, favorite, archive, and Load button stay tabbable"
        );

        // Enter selects without collapsing the roving state.
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector("#presets-list .preset-item.selected") !== null);
        state = await listState();
        assert.equal(
            state.focusKey,
            firstRowName,
            "focus must survive the re-render that selecting a preset triggers"
        );

        // A mouse click must also move the roving position, or the next arrow
        // key would jump back to wherever the keyboard last was.
        //
        // Only the first group was expanded above, so expand the second too:
        // rows in a collapsed group are display:none and cannot be clicked.
        await page.locator("#presets-list .preset-group-header").nth(1).click();
        await page.waitForFunction(() => Array.from(
            document.querySelectorAll("#presets-list .preset-group")
        ).every((group) => !group.classList.contains("collapsed")));

        const otherRow = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll("#presets-list .preset-item"))
                .filter((el) => el.offsetParent !== null);
            const row = rows[rows.length - 1];
            return row && row.getAttribute("data-preset-name");
        });
        assert.ok(
            otherRow && otherRow !== firstRowName,
            `expected a second visible row to click, got ${otherRow}`
        );

        await page.click(`#presets-list .preset-item[data-preset-name="${otherRow}"]`);
        state = await listState();
        assert.equal(state.focusKey, otherRow, "clicking a row moves the roving position to it");

        // And the next arrow key must step from the clicked row specifically.
        // Asserting the exact predecessor matters: a looser check still passes
        // while the roving key is stale, which is the bug this guards.
        const expectedPrevious = await page.evaluate((current) => {
            const items = Array.from(document.querySelectorAll(
                "#presets-list .preset-group-header, #presets-list .preset-item"
            )).filter((el) => el.offsetParent !== null);
            const index = items.findIndex((el) => el.getAttribute("data-preset-name") === current);
            const previous = index > 0 ? items[index - 1] : null;
            return previous
                && (previous.getAttribute("data-preset-name") || previous.getAttribute("data-group-key"));
        }, otherRow);

        await page.keyboard.press("ArrowUp");
        state = await listState();
        assert.equal(
            state.focusKey,
            expectedPrevious,
            "ArrowUp must step back from the clicked row, not from where the keyboard last was"
        );

        // --- Models folder: picker -> setting -> status -> model refresh ---
        await selectSection(page, "configure");
        await page.selectOption("#model-select", "smoke-model.gguf");
        await page.dispatchEvent("#model-select", "change");
        await page.click("#btn-change-models-folder");
        await page.waitForFunction(() => document.querySelector("#models-folder-path")?.textContent === "D:\\Smoke & Models");
        await page.waitForFunction(() => Array.from(document.querySelector("#model-select")?.options || [])
            .some(option => option.value === "custom-model.gguf"));
        assert.equal(await page.inputValue("#model-select"), "", "folder change must clear a missing selection");
        assert.equal(await page.inputValue("#quick-model-select"), "");
        assert.equal(modelsDirRequests.length, 1);
        assert.equal(modelsDirRequests[0].path, "D:\\Smoke & Models");
        assert.doesNotMatch(
            await page.textContent("#command-preview-text"),
            /smoke-model\.gguf/,
            "the command preview must drop the old model after the selection is cleared"
        );

        await page.click("#btn-reset-models-folder");
        await page.waitForFunction(() => document.querySelector("#models-folder-path")?.textContent === "models");
        await page.waitForFunction(() => Array.from(document.querySelector("#model-select")?.options || [])
            .some(option => option.value === "smoke-model.gguf"));
        assert.equal(modelsDirRequests.length, 2);
        assert.equal(modelsDirRequests[1].path, null);

        // ── Monitor tab ─────────────────────────────────────────────────
        // Tab wiring and the moved process-output DOM (IDs preserved).
        await selectSection(page, "monitor");
        assert.equal(await page.locator("#section-monitor #output-terminal").count(), 1,
            "the process terminal must live in the Monitor tab");
        assert.equal(await page.locator("#section-configure #output-terminal").count(), 0,
            "Configure must not keep a mirrored copy of the terminal");
        assert.equal(await page.locator("#section-monitor #input-row").count(), 1);
        assert.equal(await page.locator("#monitor-auto-scroll").count(), 0,
            "the unreliable auto-scroll toggle must not be present");
        assert.equal(await page.getAttribute("#monitor-live-badge", "aria-live"), "polite");

        // System/GPU cards render from the mocked endpoint while visible.
        await page.waitForFunction(() => document.getElementById("monitor-cpu-value")?.textContent === "18.4%");
        assert.equal(await page.textContent("#monitor-memory-value"), "37.5%");
        assert.equal(await page.textContent("#monitor-disk-read"), "1.2 MB/s");
        assert.match(await page.textContent("#monitor-live-badge"), /Live/);
        await page.waitForFunction(() => document.querySelectorAll("#monitor-card-grid [data-monitor-key^='gpu:']").length === 1);
        assert.match(await page.textContent("#monitor-card-grid"), /Smoke GPU/);
        const wideMonitorLayout = await page.locator("#monitor-card-grid").evaluate((grid) => {
            const gpu = grid.querySelector('[data-monitor-key^="gpu:"]');
            const style = getComputedStyle(grid);
            return {
                display: style.display,
                wrap: style.flexWrap,
                gpuWidth: gpu.getBoundingClientRect().width,
            };
        });
        assert.equal(wideMonitorLayout.display, "flex");
        assert.equal(wideMonitorLayout.wrap, "wrap");
        assert.ok(wideMonitorLayout.gpuWidth >= 320,
            "a trailing GPU card should grow beyond the old cramped track width");

        await page.setViewportSize({ width: 760, height: 720 });
        const narrowMonitorLayout = await page.locator("#monitor-card-grid").evaluate((grid) => ({
            clientWidth: grid.clientWidth,
            scrollWidth: grid.scrollWidth,
            cardWidths: Array.from(grid.children)
                .filter(card => !card.classList.contains("hidden"))
                .map(card => card.getBoundingClientRect().width),
        }));
        assert.ok(narrowMonitorLayout.scrollWidth <= narrowMonitorLayout.clientWidth + 1,
            "wrapped monitor cards must not overflow at a narrow viewport");
        assert.ok(narrowMonitorLayout.cardWidths.every(width => width >= 220),
            "narrow monitor cards retain their readable minimum width");
        await page.setViewportSize({ width: 1280, height: 720 });
        assert.ok(await page.locator("#monitor-gpu-setup").evaluate(el => el.classList.contains("hidden")),
            "working probes produce no setup cards");

        // Recheck bypasses the backend cache via the fixed refresh=1 form.
        await page.click("#btn-monitor-recheck");
        await wait(200);
        assert.ok(systemStatsRequests.some(url => url.includes("refresh=1")),
            "Recheck must request /api/system-stats?refresh=1");

        // Backlog renders, Clear empties the terminal without replaying it.
        outputRunningFlag = true;
        outputQueue = ["smoke line one", "smoke line two"];
        await page.evaluate(() => startOutputPolling(null));
        await page.waitForFunction(() => document.getElementById("output-terminal").textContent.includes("smoke line two"));
        await page.click("#btn-clear-output");
        assert.equal(await page.locator("#output-terminal div").count(), 0, "Clear empties the terminal");
        assert.match(await page.evaluate(() => processOutputCursor.getUrl()), /since=\d+/,
            "Clear must preserve the cursor so the backlog does not replay");
        const outputCountAfterClear = outputRequests.length;
        await wait(400);
        assert.ok(outputRequests.slice(outputCountAfterClear).every(url => url.includes("since=")),
            "polls after Clear must not request the backlog from the start");
        assert.ok(!(await page.textContent("#output-terminal")).includes("smoke line one"),
            "no replayed backlog after Clear");
        await page.evaluate(() => stopOutputPolling());
        outputRunningFlag = false;

        // Hide/restore: everything except Process Output can be hidden.
        await page.click('[data-monitor-hide="system:cpu"]');
        await page.waitForFunction(() => document.querySelector('[data-monitor-key="system:cpu"]')
            ?.classList.contains("hidden"));
        assert.match(await page.textContent("#monitor-hidden-count"), /1 card hidden/);
        await page.evaluate(() => { document.getElementById("monitor-hidden-controls").open = true; });
        await page.click("#btn-monitor-show-all");
        await page.waitForFunction(() => !document.querySelector('[data-monitor-key="system:cpu"]')
            ?.classList.contains("hidden"));
        assert.ok(await page.locator("#monitor-hidden-controls").evaluate(el => el.classList.contains("hidden")),
            "the restore control disappears when nothing is hidden");

        // Inference card: empty state without a server, then one shared
        // snapshot feeds both the fixed bar and the card with one baseline.
        assert.ok(await page.locator("#monitor-inference-empty").isVisible(),
            "the Inference card shows its empty state before any target");
        statsMetrics = {
            promptTokens: 70,
            promptSpeed: 5,
            genTokens: 30,
            genSpeed: 3,
            processing: 1,
        };
        statsSlots = [{
            id: 0,
            id_task: 1,
            n_ctx: 1000,
            is_processing: true,
            n_prompt_tokens: 250,
            n_prompt_tokens_processed: 70,
            next_token: { n_decoded: 30 },
        }];
        await page.evaluate(async () => {
            startStatsPolling({ generation: 99 }, { operation: "manual-launch" });
            await pollStats();
        });
        assert.equal(await page.textContent("#stats-context"), "100");
        assert.equal(await page.textContent("#monitor-inference-total"), "100 tokens",
            "the Inference card must agree with the fixed bar's session baseline");
        assert.match(await page.textContent("#monitor-inference-context-reading"), /250 \/ 1,000/);
        assert.match(await page.textContent("#monitor-inference-context-label"), /active/,
            "a processing slot is labeled active");
        assert.match(await page.textContent("#monitor-inference-state-badge"), /1 active/);

        // Reset updates both views immediately from the shared baseline.
        await page.click("#btn-reset-inference");
        assert.equal(await page.textContent("#stats-context"), "0");
        assert.equal(await page.textContent("#monitor-inference-total"), "0 tokens");
        await page.evaluate(() => stopStatsPolling());

        // System polling stops while the Monitor panel is hidden.
        const systemCountWhileVisible = systemStatsRequests.length;
        await selectSection(page, "configure");
        await wait(2600);
        assert.equal(systemStatsRequests.length, systemCountWhileVisible,
            "system stats must not poll while the Monitor tab is hidden");

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
