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

async function main() {
    const { chromium } = loadPlaywright();
    const port = await findFreePort(START_PORT);
    const server = await startStaticServer(port);
    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();
        const chatCompletionBodies = [];
        const launchBodies = [];

        await page.route("**/api/**", async (route) => {
            const url = new URL(route.request().url());
            const pathName = url.pathname;
            if (pathName === "/api/chat/completions") {
                chatCompletionBodies.push(JSON.parse(route.request().postData() || "{}"));
                await route.fulfill({
                    status: 200,
                    contentType: "text/event-stream",
                    body: [
                        'data: {"choices":[{"delta":{"content":"ok"}}]}',
                        "",
                        "data: [DONE]",
                        "",
                    ].join("\n"),
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
                        running: false,
                        backend: "cpu",
                        tag: "smoke",
                        available_backends: [{ id: "cpu", label: "CPU" }],
                    }),
                });
                return;
            }
            if (pathName === "/api/releases") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([{ tag: "smoke", published: "2026-01-01T00:00:00Z" }]),
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

        await page.selectOption("#quick-profile-select", "low-memory");
        await page.dispatchEvent("#quick-profile-select", "change");
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().ctx_size === 8192);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().batch_size === 1024);
        await page.waitForFunction(() => document.querySelector("#command-preview-text")?.textContent.includes("-c 8192"));
        assert.match(await page.textContent("#quick-profile-summary"), /lighter setup/i);

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

        await page.fill("#config-search", "metrics");
        await page.waitForSelector("#flag-metrics", { state: "visible" });
        await page.click("#flag-metrics");
        await page.waitForFunction(() => document.querySelector("#quick-metrics-toggle")?.checked === false);
        await page.click("#flag-metrics");
        await page.waitForFunction(() => document.querySelector("#quick-metrics-toggle")?.checked === true);
        await page.evaluate(() => startStatsPolling());
        await page.waitForFunction(() => document.querySelector("#stats-kv-usage")?.textContent === "13%");
        await page.evaluate(() => stopStatsPolling());

        await selectSection(page, "chat");
        await page.evaluate(() => {
            window.LlamaGui.flagCore.setFlagValue("temperature", 0.31);
        });
        await page.waitForFunction(() => document.querySelector("#chat-slider-temp")?.value === "0.31");
        assert.equal(await page.textContent("#chat-val-temp"), "0.31");

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

        await selectSection(page, "quick-launch");
        await page.fill("#quick-temperature", "0.42");
        await page.dispatchEvent("#quick-temperature", "input");
        await page.waitForTimeout(250);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.42);
        await page.waitForFunction(() => document.querySelector("#chat-slider-temp")?.value === "0.42");
        await page.fill("#quick-temperature", ".96");
        await page.dispatchEvent("#quick-temperature", "input");
        await page.fill("#quick-repeat-penalty", "1.02");
        await page.dispatchEvent("#quick-repeat-penalty", "input");
        await page.fill("#quick-presence-penalty", "0.3");
        await page.dispatchEvent("#quick-presence-penalty", "input");
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

        const launchArgs = await page.evaluate(() => window.LlamaGui.flagCore.getLaunchArgs().args.flat());
        assert.ok(launchArgs.includes("-c") && launchArgs.includes("12345"));
        assert.ok(launchArgs.includes("-ngl") && launchArgs.includes("9"));
        assert.ok(launchArgs.includes("--temp") && launchArgs.includes("0.96"));
        assert.ok(launchArgs.includes("--repeat-penalty") && launchArgs.includes("1.02"));
        assert.ok(launchArgs.includes("--presence-penalty") && launchArgs.includes("0.3"));

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
            raw: window.LlamaGui.flagCore.collectFlagValues().custom_args,
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
        let launchDialogMessage = "";
        page.once("dialog", async (dialog) => {
            launchDialogMessage = dialog.message();
            await dialog.accept();
        });
        await page.click("#btn-launch");
        assert.match(launchDialogMessage, /unmatched single quote/);
        assert.equal(launchBodies.length, launchCountBefore);

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
