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
                    "llamacpp:kv_cache_usage_ratio 0",
                ].join("\n"),
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
        await page.waitForTimeout(250);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().temperature === 0.96);
        await page.waitForFunction(() => window.LlamaGui.flagCore.getFlagValues().repeat_penalty === 1.02);
        assert.equal(await page.locator("#quick-temperature").evaluate((el) => el.validity.valid), true);
        assert.equal(await page.locator("#quick-repeat-penalty").evaluate((el) => el.validity.valid), true);
        await selectSection(page, "configure");
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
