const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { character, pngCard } = require("./character_card_fixtures.cjs");

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

async function verifyConfigurePresentation(page) {
    await page.fill("#config-search", "context & memory");
    await page.waitForSelector("#flag-ctx_size", { state: "visible" });
    const contextHeader = page.locator('.accordion[data-category-id="context"] .accordion-header');
    const contextRow = page.locator('.flag-row[data-flag-id="ctx_size"]');

    assert.equal(await page.getByRole("spinbutton", { name: "Total Context Window -c", exact: true }).getAttribute("id"), "flag-ctx_size");
    await contextRow.locator(".flag-setting-name").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "flag-ctx_size", "setting labels focus their inputs");
    assert.match(await contextRow.locator(".flag-default").textContent(), /GUI default: 64000/);

    const help = contextRow.locator(".flag-more");
    assert.equal(await help.locator(".flag-tip-text").isVisible(), false, "usage tips stay out of the collapsed row");
    await help.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await help.locator(".flag-tip-text").isVisible(), true, "detailed help opens from the keyboard");
    await page.keyboard.press("Enter");

    await contextHeader.focus();
    await page.keyboard.press("Space");
    assert.equal(await contextHeader.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#flag-ctx_size").isVisible(), false);
    await page.keyboard.press("Enter");
    assert.equal(await contextHeader.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#flag-ctx_size").isVisible(), true);
    assert.equal(await contextHeader.getAttribute("aria-controls"), "flag-category-context");

    const numberColumns = await page.locator("#flag-ctx_size, #flag-batch_size, #flag-ubatch_size")
        .evaluateAll(inputs => inputs.map(input => {
            const rect = input.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
        }));
    assert.equal(numberColumns.length, 3);
    assert.ok(numberColumns.every(rect => Math.abs(rect.left - numberColumns[0].left) < 1
        && Math.abs(rect.right - numberColumns[0].right) < 1), "numeric controls share an aligned column");
    assert.match(await page.locator('.flag-row[data-flag-id="mlock"] .flag-desc').textContent(), /Deprecated/);

    await page.fill("#config-search", "sampling");
    const submenu = page.locator('.accordion[data-category-id="sampling"] .flag-submenu-header').first();
    await submenu.waitFor({ state: "visible" });
    assert.equal(await submenu.getAttribute("aria-expanded"), "true");
    await submenu.focus();
    await page.keyboard.press("Enter");
    assert.equal(await submenu.getAttribute("aria-expanded"), "false");

    await page.fill("#config-search", "");
    await page.click("#btn-expand-all");
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    const overflowingControls = await page.locator(".flag-row").evaluateAll(rows => rows.flatMap(row => {
        const bounds = row.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return [];
        return Array.from(row.querySelectorAll(".flag-input input, .flag-input select, .flag-input textarea, .flag-input button"))
            .filter(input => {
                const rect = input.getBoundingClientRect();
                return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
            })
            .map(input => input.id || row.dataset.flagId);
    }));
    assert.deepEqual(overflowingControls, [], "simple, path, sensitive, and multi-value controls fit narrow rows");
    await page.setViewportSize(viewport);
}

async function verifyReasoningPreserve(page) {
    await page.fill("#config-search", "preserve reasoning");
    const selector = "#flag-reasoning_preserve";
    await page.waitForSelector(selector, { state: "visible" });
    assert.equal(await page.inputValue(selector), "auto");
    assert.match(await page.locator('.flag-row[data-flag-id="reasoning_preserve"] .flag-desc').textContent(), /Auto follows the binary default.*compatible templates.*more context/);
    assert.deepEqual(await page.locator(`${selector} option`).allTextContents(), ["Auto", "Enabled", "Disabled"]);
    for (const mode of ["enabled", "disabled", "auto"]) {
        await page.selectOption(selector, mode);
        assert.equal(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues().reasoning_preserve), mode);
        const command = await page.textContent("#command-preview-text");
        assert.equal(/(?:^| )--reasoning-preserve(?: |$)/.test(command), mode === "enabled");
        assert.equal(/(?:^| )--no-reasoning-preserve(?: |$)/.test(command), mode === "disabled");
        await page.fill("#config-search", "context");
        await page.fill("#config-search", "preserve reasoning");
        assert.equal(await page.inputValue(selector), mode, "rebuilding Configure preserves the selected mode");
    }
    for (const [legacy, mode] of [[true, "enabled"], [false, "auto"]]) {
        await page.evaluate(value => {
            const core = window.LlamaGui.flagCore;
            core.applyFlagValues({ ...core.getFlagValues(), reasoning_preserve: value });
        }, legacy);
        assert.equal(await page.inputValue(selector), mode, "legacy preset values restore the correct dropdown option");
    }
    assert.doesNotMatch(await page.textContent("#command-preview-text"), /--(?:no-)?reasoning-preserve/);
    await page.fill("#config-search", "");
}

async function verifyNgramSimple(page) {
    await selectSection(page, "configure");
    await page.fill("#config-search", "ngram");
    const toggle = page.locator("#flag-ngram_simple");
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.inputValue("#flag-ngram_simple_size_n"), "");
    assert.equal(await page.inputValue("#flag-ngram_simple_size_m"), "");
    for (const id of ["ngram_simple", "ngram_mod"]) {
        const guidance = page.locator(`.flag-row[data-flag-id="${id}"] .flag-desc`);
        assert.equal(await guidance.isVisible(), true);
        assert.match(await guidance.textContent(), /individually first.*Simple is tried first.*fallback/);
    }
    await page.fill("#flag-ngram_simple_size_n", "8");
    await page.fill("#flag-ngram_simple_size_m", "16");
    assert.doesNotMatch(await page.textContent("#command-preview-text"), /--spec-ngram-simple/);
    await toggle.check();
    assert.equal(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues().ngram_simple), true);
    assert.match(await page.textContent("#command-preview-text"), /--spec-type ngram-simple(?: |$)/);
    assert.match(await page.textContent("#command-preview-text"), /--spec-ngram-simple-size-n 8/);
    assert.match(await page.textContent("#command-preview-text"), /--spec-ngram-simple-size-m 16/);
    await page.check("#flag-ngram_mod");
    let command = await page.textContent("#command-preview-text");
    assert.equal((command.match(/--spec-type /g) || []).length, 1);
    assert.match(command, /ngram-mod,ngram-simple/);
    await toggle.uncheck();
    assert.equal(await page.inputValue("#flag-ngram_simple_size_n"), "8");
    assert.doesNotMatch(await page.textContent("#command-preview-text"), /--spec-ngram-simple/);
    await toggle.check();
    assert.match(await page.textContent("#command-preview-text"), /--spec-ngram-simple-size-m 16/);
    // Rebuilding Configure from search must preserve shared values and toggles.
    await page.fill("#config-search", "context");
    await page.fill("#config-search", "ngram simple");
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await page.inputValue("#flag-ngram_simple_size_m"), "16");
    assert.equal(await page.locator('#section-quick-launch input[id*="ngram_simple"]').count(), 0);
    await page.evaluate(() => window.LlamaGui.flagCore.setMultipleFlagValues({
        ngram_simple: false, ngram_mod: false, ngram_simple_size_n: undefined, ngram_simple_size_m: undefined,
    }));
    await page.fill("#config-search", "");
}

async function verifyConfigureComparison(page) {
    await selectSection(page, "configure");
    await page.fill("#config-search", "context & memory");
    await page.waitForSelector("#flag-ctx_size", { state: "visible" });
    const original = await page.inputValue("#flag-ctx_size");
    const row = page.locator('.flag-row[data-flag-id="ctx_size"]');
    assert.equal(await page.textContent("#config-runtime-state"), "Process active · action failed", "a failed stop does not describe the process as stopped");
    assert.equal(await page.textContent("#config-change-count"), "Settings match launch");
    assert.equal(await row.locator(".flag-baseline-value").textContent(), original);
    await page.fill("#flag-ctx_size", String(Number(original) + 1));
    assert.equal(await page.textContent("#config-change-count"), "1 setting changed since launch");
    assert.match(await page.locator('.accordion[data-category-id="context"] .count').first().textContent(), /1 changed/);
    await page.check("#config-changes-only");
    assert.equal(await page.locator('.flag-row:not(.hidden)').count(), 1);
    await page.fill("#flag-ctx_size", original);
    assert.equal(await row.isVisible(), true, "typing through the launch value must not hide the focused input");
    await page.locator("#config-search").focus();
    await row.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#config-comparison-empty").isVisible(), true);
    await page.uncheck("#config-changes-only");
    await page.fill("#flag-ctx_size", String(Number(original) + 2));
    await row.locator(".flag-revert").click();
    assert.equal(await page.inputValue("#flag-ctx_size"), original);
    assert.equal(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues().ctx_size), Number(original));
    assert.match(await page.textContent("#command-preview-text"), new RegExp(`-c ${original}(?: |$)`));
    await page.evaluate(() => window.LlamaGui.flagCore.setMultipleFlagValues({ ctx_size: 32768, port: 9091 }));
    await page.locator("#config-change-review > summary").click();
    assert.equal(await page.locator("#config-change-list tr").count(), 2, "review includes changes outside the search");
    assert.equal(await page.locator("#config-comparison-exclusions").isVisible(), false);
    await page.locator("#config-comparison-about > summary").click();
    assert.equal(await page.locator("#config-comparison-exclusions").isVisible(), true);
    assert.match(await page.textContent("#config-comparison-exclusions"), /Automatic values, API keys, and custom launch arguments aren’t compared/);
    assert.ok(!await page.locator(".config-runtime").textContent().then(text => text.includes("first-secret")));
    const viewport = page.viewportSize();
    for (const width of [820, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await row.evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return Array.from(el.querySelectorAll("input, .flag-baseline, .flag-revert")).some(child => {
                const rect = child.getBoundingClientRect();
                return rect.width && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
            });
        }), false, `comparison controls fit a ${width}px viewport`);
    }
    await page.setViewportSize(viewport);
    await page.click("#config-revert-changes");
    assert.equal(await page.textContent("#config-change-count"), "Settings match launch");
    assert.equal(await page.inputValue("#flag-ctx_size"), original);
    const selectedModel = await page.evaluate(() => window.LlamaGui.flagCore.getSelectedModel());
    await page.evaluate(() => {
        window.LlamaGui.flagCore.setSelectedModelValue("different.gguf");
        window.LlamaGui.flagCore.updateCommandPreview();
    });
    assert.match(await page.textContent("#config-comparison-exclusions"), /selected a different model/);
    await page.evaluate(model => {
        window.LlamaGui.flagCore.setSelectedModelValue(model);
        window.LlamaGui.flagCore.updateCommandPreview();
    }, selectedModel);
    await page.evaluate(() => window.LlamaGui.flagCore.setCurrentTool("llama-cli"));
    assert.equal(await page.locator("#config-changes-only").isDisabled(), true);
    assert.match(await page.textContent("#config-comparison-note"), /Select llama-server/);
    await page.evaluate(() => window.LlamaGui.flagCore.setCurrentTool("llama-server"));
    assert.equal(await page.textContent("#config-change-count"), "Settings match launch");
}

async function verifyConfigureReset(page) {
    await selectSection(page, "configure");
    await page.evaluate(() => refreshModels());
    await page.selectOption("#model-select", "smoke-model.gguf");
    await page.evaluate(() => window.LlamaGui.flagCore.setMultipleFlagValues({
        ctx_size: 8192, temperature: 0.37, port: 9091, gpu_layers: 7,
        chat_template: "chatml", custom_args: '--threads "unfinished',
    }));
    const baseline = await page.evaluate(() => window.LlamaGui.flagCore.captureLaunchSettings());
    const runtime = { generation: 401, tool: "llama-server", model: "models/smoke-model.gguf", host: "127.0.0.1", port: 9091, launch_settings: baseline };
    const status = await page.evaluate(() => fetchJson("/api/status"));
    await page.route("**/api/status", route => route.fulfill({ json: { ...status, running: true, active_process_tool: "llama-server", active_runtime: runtime } }));
    await page.route("**/api/llama/health?*", route => route.fulfill({ json: { state: "ready", ready: true, generation: 401 } }));
    await page.evaluate(activeRuntime => processLifecycle.restore({ running: true, active_runtime: activeRuntime }, {
        startOutput: () => {}, startStats: () => {}, postReady: () => {},
    }), runtime);
    await page.selectOption("#tool-select", "llama-cli");
    const original = await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues());
    const savedPresets = await page.evaluate(() => fetchJson("/api/presets"));
    const history = JSON.stringify([{ id: "reset-history", title: "Keep this chat", messages: [] }]);
    await page.evaluate(value => localStorage.setItem("llama_gui_conversations", value), history);
    const writes = [];
    page.on("request", request => {
        if (request.method() !== "GET" && /\/api\/(launch|stop|presets|shutdown|restart)(?:[/?]|$)/.test(request.url())) writes.push(request.url());
    });
    const button = page.locator("#btn-config-reset");
    const dialog = page.getByRole("dialog", { name: "Reset configuration to defaults?", exact: true });
    for (const dismiss of ["cancel", "escape", "enter"]) {
        await button.click();
        await dialog.waitFor({ state: "visible" });
        assert.equal(await dialog.locator("button[value=cancel]").evaluate(el => el === document.activeElement), true);
        if (dismiss === "cancel") await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        else await page.keyboard.press(dismiss === "escape" ? "Escape" : "Enter");
        await dialog.waitFor({ state: "hidden" });
        assert.deepEqual(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues()), original, "dismissing leaves every setting intact");
        assert.equal(await button.evaluate(el => el === document.activeElement), true, "dismissal restores focus to Reset");
    }
    await button.click();
    await dialog.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await page.waitForFunction(() => !window.LlamaGui.flagCore.getFlagValues().custom_args);
    const defaults = await page.evaluate(() => getDefaultValues());
    assert.deepEqual(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues()), defaults, "reset replaces all overrides, including hidden flags and custom args");
    assert.equal(await page.inputValue("#tool-select"), "llama-cli");
    assert.equal(await page.inputValue("#model-select"), "smoke-model.gguf");
    assert.equal(await page.inputValue("#custom-launch-args"), "");
    assert.doesNotMatch(await page.textContent("#command-preview-text"), /Cannot launch|unfinished|--threads|--chat-template/);
    assert.match(await page.textContent("#command-preview-text"), /smoke-model\.gguf/);
    assert.equal(await page.inputValue("#flag-ctx_size"), String(defaults.ctx_size));
    assert.equal(await page.inputValue("#quick-temperature-input"), String(defaults.temperature));
    assert.equal(await page.inputValue("#chat-slider-temp"), String(defaults.temperature));
    assert.equal(await page.inputValue("#quick-port"), String(defaults.port));
    assert.equal(await page.evaluate(() => localStorage.getItem("llama_gui_conversations")), history);
    assert.deepEqual(await page.evaluate(() => fetchJson("/api/presets")), savedPresets);
    assert.deepEqual(await page.evaluate(() => processLifecycle.getSnapshot().activeRuntime), runtime);
    await page.selectOption("#tool-select", "llama-server");
    assert.match(await page.textContent("#config-change-count"), /changed since launch/);
    await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("temperature", 0.22));
    const viewport = page.viewportSize();
    for (const width of [1440, 900, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await button.click();
        assert.equal(await page.locator(".config-controls, #config-reset-dialog").evaluateAll(elements => elements.every(el => {
            const bounds = el.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
        })), true, `reset toolbar and dialog fit at ${width}px`);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => window.LlamaGui.flagCore.getFlagValues().temperature), 0.22, "Escape after a previous reset must not reuse its confirmation");
    }
    await page.setViewportSize(viewport);
    assert.deepEqual(writes, [], "reset never writes presets or launches/stops a process");
}

async function verifyPresetPolish(page) {
    const entries = [
        { name: "Daily server", data: { tool: "llama-server", model: "smoke-model.gguf", flags: {
            temperature: 0.4, batch_size: 1024, ubatch_size: "512", gpu_layers: "all",
            flash_attn: "on", mlock: true, reasoning_preserve: false,
            hf_token: "hidden-hf-token", api_key: "hidden-api-key", ctx_size_draft: 99,
            custom_args: "--alias daily", unknown_legacy_flag: "<img src=x>" + "long-value".repeat(20),
        } } },
        { name: "Another preset", data: { tool: "llama-server", model: "smoke-model.gguf", flags: { ctx_size: 0 } } },
    ];
    const writes = [];
    let failSave = false;
    const handler = async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "GET") return route.fulfill({ json: entries });
        const body = request.postDataJSON();
        if (pathname === "/api/presets/rename") {
            entries.find(entry => entry.name === body.name).name = body.new_name;
            return route.fulfill({ json: { renamed: true, name: body.new_name } });
        }
        if (pathname === "/api/presets/archive") {
            for (const entry of entries) if (body.names.includes(entry.name)) entry.archived = body.archived;
            return route.fulfill({ json: { archived: body.archived, count: body.names.length } });
        }
        writes.push(body);
        const existing = entries.find(entry => entry.name.toLowerCase() === body.name.toLowerCase());
        if (existing && body.overwrite === false) return route.fulfill({ status: 409, json: { error: "Preset already exists" } });
        if (failSave) return route.fulfill({ status: 500, json: { error: "Could not save preset" } });
        if (existing) existing.data = body.data;
        else entries.push({ name: body.name, data: body.data });
        return route.fulfill({ json: { saved: true, name: body.name } });
    };
    await page.route("**/api/presets**", handler);
    const runtimeBefore = await page.evaluate(() => JSON.stringify(processLifecycle.getSnapshot().activeRuntime));
    const config = page.locator("#section-configure [data-preset-context]");
    const quick = page.locator("#section-quick-launch [data-preset-context]");
    try {
        await page.evaluate(() => {
            presetSearchQuery = "";
            presetFavoritesMode = "all";
            presetWarningFilterActive = false;
            presetArchiveViewActive = false;
            document.getElementById("preset-search").value = "";
            savePresetGroupState({});
            flagCore.setFlagValue("api_key", "session-only-api-key");
        });
        await selectSection(page, "presets");
        await page.locator("#presets-list .preset-group-header").first().waitFor();
        await page.click("#btn-presets-expand-all");
        await page.locator('.preset-item[data-preset-name="Daily server"]').click();
        assert.equal(await page.getByRole("button", { name: "Duplicate", exact: true }).isVisible(), false);
        assert.match(await page.textContent(".preset-detail-stats"), /GUI default/);
        await page.locator(".preset-saved-settings > summary").click();
        const table = page.locator(".preset-saved-values");
        assert.deepEqual(await table.locator("thead th").allTextContents(), ["Setting", "Saved value", "GUI default"]);
        for (const [label, saved, defaultValue] of [
            ["Prompt Batch Size", "1024", "2048"],
            ["Physical Batch Size", "512", ""],
            ["GPU Layers", "All layers", "Auto"],
            ["Flash Attention", "On", "Auto (default)"],
            ["Lock Model in RAM", "Enabled", "Disabled"],
            ["Preserve Reasoning", "Auto", ""],
        ]) {
            const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });
            assert.deepEqual(await row.locator("td").allTextContents(), [saved, defaultValue], label);
        }
        assert.equal(await table.locator("tbody tr").last().locator("td").last().textContent(), "Unavailable");
        assert.equal(await table.locator("img").count(), 0, "saved values render as text");
        assert.doesNotMatch(await page.textContent(".preset-saved-settings"), /hidden-hf-token|hidden-api-key|--alias daily|ctx_size_draft/);
        const changedRows = await table.locator("tbody tr").evaluateAll(rows => rows.filter(row => row.lastElementChild.textContent !== "").length);
        assert.match(await page.textContent(".preset-saved-settings > summary"), new RegExp(`${changedRows} non-default overrides`));
        const viewport = page.viewportSize();
        for (const width of [390, 900, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.ok(await table.evaluate(el => el.getBoundingClientRect().width > 0 && el.scrollWidth <= el.clientWidth + 1), `saved settings fit at ${width}px`);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `preset page fits at ${width}px`);
        }
        await page.setViewportSize(viewport);
        await page.getByRole("button", { name: "Load into Configure", exact: true }).click();
        await config.waitFor({ state: "visible" });
        assert.equal(await config.locator("[data-preset-name]").textContent(), "Daily server");
        assert.equal(await config.locator("[data-preset-state]").textContent(), "Matches saved preset");
        assert.equal(await config.locator("[data-preset-update]").isDisabled(), true);

        await page.evaluate(() => flagCore.setMultipleFlagValues({ temperature: 0.25, hf_token: "changed-hf-token", custom_args: "--alias changed" }));
        assert.equal(await config.locator("[data-preset-state]").textContent(), "Modified");
        await config.locator("[data-preset-review-label]").click();
        await config.locator("tbody tr").first().waitFor();
        assert.doesNotMatch(await config.locator("tbody").textContent(), /hidden-hf-token|changed-hf-token|--alias|session-only-api-key/);
        assert.match(await config.locator("tbody").textContent(), /Changed · value hidden/);
        await selectSection(page, "quick-launch");
        assert.equal(await quick.locator("[data-preset-state]").textContent(), "Modified");
        await selectSection(page, "presets");
        await page.locator('.preset-item[data-preset-name="Another preset"]').click();
        assert.match(await page.textContent(".preset-detail-stats"), /Auto · from model/);
        assert.equal(await config.locator("[data-preset-name]").textContent(), "Daily server", "browsing must not change the edit source");
        await selectSection(page, "configure");
        await config.locator("[data-preset-update]").click();
        await page.locator("#preset-update-dialog[open]").waitFor();
        assert.match(await page.textContent("#preset-update-title"), /Daily server/);
        assert.doesNotMatch(await page.textContent("#preset-update-dialog tbody"), /changed-hf-token|--alias/);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !presetSavePending);
        assert.equal(writes.length, 0, "cancelling the review must not write");
        assert.equal(await config.locator("[data-preset-update]").evaluate(el => el === document.activeElement), true, "cancelling restores keyboard focus");

        // The save uses the reviewed snapshot even if settings change while open.
        await config.locator("[data-preset-update]").click();
        await page.locator("#preset-update-dialog[open]").waitFor();
        await page.evaluate(() => flagCore.setFlagValue("temperature", 0.6));
        await page.locator('#preset-update-dialog button[value="update"]').click();
        await page.waitForFunction(() => !presetSavePending);
        assert.equal(writes.at(-1).data.flags.temperature, 0.25);
        assert.equal(writes.at(-1).data.flags.api_key, undefined);
        assert.equal(await config.locator("[data-preset-state]").textContent(), "Modified");
        await page.evaluate(() => flagCore.setFlagValue("temperature", 0.25));
        assert.equal(await config.locator("[data-preset-state]").textContent(), "Matches saved preset");

        await config.locator("[data-preset-save-new]").click();
        await page.fill("#prompt-modal-input", "Daily server");
        await page.click("#prompt-modal-ok");
        await page.waitForFunction(() => !presetSavePending);
        assert.equal(writes.at(-1).overwrite, false);
        assert.equal(entries.length, 2, "save as new must reject a name collision");
        assert.match(await page.textContent("#preset-status"), /already exists/);
        const newName = "New <img src=x> " + "long preset name ".repeat(6);
        await config.locator("[data-preset-save-new]").click();
        await page.fill("#prompt-modal-input", newName.trim());
        await page.click("#prompt-modal-ok");
        await page.waitForFunction(() => !presetSavePending);
        assert.equal(await config.locator("[data-preset-name]").textContent(), newName.trim());
        assert.equal(await config.locator("img").count(), 0);
        await config.locator("[data-preset-name]").click();
        await page.waitForFunction(() => document.activeElement?.classList.contains("preset-detail-title"));
        assert.equal(await page.textContent(".preset-detail-title"), newName.trim());

        await page.locator(".preset-more-actions > summary").focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".preset-more-actions").evaluate(el => el.open), false);
        await page.locator(".preset-more-actions > summary").click();
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        await page.fill("#prompt-modal-input", "Renamed source");
        await page.click("#prompt-modal-ok");
        await page.waitForFunction(() => lastLoadedPresetName === "Renamed source");
        // Source links must clear filters that would hide the requested preset.
        await selectSection(page, "configure");
        await config.locator("[data-preset-name]").click();
        await page.waitForFunction(() => document.querySelector(".preset-detail-title")?.textContent === "Renamed source");
        await page.locator(".preset-more-actions > summary").click();
        await page.locator("#preset-detail-panel").getByRole("button", { name: "Archive", exact: true }).click();
        await page.waitForFunction(() => loadedPresetArchived);
        await selectSection(page, "quick-launch");
        await quick.locator("[data-preset-name]").click();
        await page.waitForFunction(() => document.querySelector(".preset-detail-title")?.textContent === "Renamed source");
        assert.match(await page.textContent("#preset-archive-view"), /Viewing archive/);

        // Failure leaves the source and pending edits available for retry.
        await selectSection(page, "configure");
        await page.evaluate(() => flagCore.setFlagValue("temperature", 0.5));
        failSave = true;
        await config.locator("[data-preset-update]").click();
        await page.locator("#preset-update-dialog[open]").waitFor();
        await page.locator('#preset-update-dialog button[value="update"]').click();
        await page.waitForFunction(() => !presetSavePending);
        assert.equal(await config.locator("[data-preset-update]").isEnabled(), true);
        assert.equal(await config.locator("[data-preset-state]").textContent(), "Modified");
        failSave = false;

        for (const section of ["configure", "quick-launch", "presets"]) {
            await selectSection(page, section);
            for (const width of [390, 900, 1440]) {
                await page.setViewportSize({ width, height: 1000 });
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${section} fits at ${width}px`);
            }
        }
        await selectSection(page, "configure");
        await config.locator("[data-preset-update]").click();
        await page.locator("#preset-update-dialog[open]").waitFor();
        const writesBeforeRemoval = writes.length;
        entries.splice(entries.findIndex(entry => entry.name === "Renamed source"), 1);
        await page.locator('#preset-update-dialog button[value="update"]').click();
        await page.waitForFunction(() => !presetSavePending);
        assert.equal(writes.length, writesBeforeRemoval, "deleting a preset during review must not recreate it");
        assert.equal(await config.locator("[data-preset-state]").textContent(), "No longer saved");
        assert.equal(await config.locator("[data-preset-update]").isDisabled(), true);
        assert.equal(await config.locator("[data-preset-save-new]").isEnabled(), true);
        assert.equal(await page.evaluate(() => JSON.stringify(processLifecycle.getSnapshot().activeRuntime)), runtimeBefore, "preset edits must not change the active runtime");
    } finally {
        await page.unroute("**/api/presets**", handler);
    }
}

async function verifyQuickLaunchPolish(page) {
    const baseStatus = await page.evaluate(() => fetchJson("/api/status"));
    let activeRuntime = null;
    let entries = [
        { name: "Recent session", data: { tool: "llama-server", model: "smoke-model.gguf", flags: { temperature: 0.4 } } },
        { name: "Favorite session", data: { tool: "llama-server", model: "smoke-model.gguf", flags: { temperature: 0.8 } } },
        { name: "A very long saved preset name with <img src=x> text", data: { tool: "llama-cli", model: "folder/" + "long-model-name-".repeat(12) + ".gguf", flags: {} } },
        { name: "Archived", archived: true, data: { tool: "llama-server", model: "smoke-model.gguf", flags: {} } },
        { name: "Legacy sampler", data: { temperature: 0.7 } },
    ];
    let failPresets = false;
    const status = () => ({ ...baseStatus, running: Boolean(activeRuntime), active_process_tool: activeRuntime?.tool, active_runtime: activeRuntime, external_chat_target: null });
    const routes = {
        "**/api/status": route => route.fulfill({ json: status() }),
        "**/api/llama/health?*": route => route.fulfill({ json: { state: "ready", ready: true, generation: activeRuntime?.generation } }),
        "**/api/presets": route => route.fulfill({ status: failPresets ? 500 : 200, json: failPresets ? { error: "Unavailable" } : entries }),
    };
    for (const [url, handler] of Object.entries(routes)) await page.route(url, handler);
    await page.evaluate(async () => {
        stopOutputPolling(); stopStatsPolling();
        localStorage.setItem("llama_gui_preset_favorites_v1", JSON.stringify({ "Favorite session": true }));
        localStorage.setItem("llama_gui_preset_last_used_v1", JSON.stringify({ "Recent session": 123 }));
        await processLifecycle.restore({ running: false, active_runtime: null });
        flagCore.setCurrentTool("llama-server");
        flagCore.applyFlagValues(getDefaultValues());
    });
    await selectSection(page, "quick-launch");
    await page.waitForFunction(() => document.querySelector(".quick-saved-preset")?.dataset.presetName === "Favorite session");
    assert.equal(await page.locator(".quick-saved-preset").count(), 3);
    assert.equal(await page.locator(".quick-saved-preset img").count(), 0, "preset names are plain text");
    assert.equal(await page.textContent("#quick-runtime-state"), "Stopped");
    assert.equal(await page.textContent("#quick-models-folder-path"), await page.textContent("#models-folder-path"));
    for (const disclosure of await page.locator("#section-quick-launch details").all()) {
        if (await disclosure.evaluate(el => el.open)) await disclosure.locator(":scope > summary").click();
    }
    if (await page.locator("#model-switch-toggle").getAttribute("aria-expanded") === "true") await page.click("#model-switch-toggle");
    await page.locator(".quick-saved-preset").first().click();
    // The preset can already match before its async reload completes. Wait for
    // the load to finish before editing, or its response can overwrite the edit.
    await page.waitForFunction(() => {
        const preset = document.querySelector(".quick-saved-preset");
        return preset && !preset.disabled && preset.getAttribute("aria-pressed") === "true";
    });
    assert.equal(await page.inputValue("#quick-model-select"), "smoke-model.gguf");
    assert.equal(await page.textContent("#btn-quick-launch-label"), "Launch server");
    await page.fill("#quick-temperature-input", "0.43");
    assert.equal(await page.evaluate(() => flagCore.getFlagValues().temperature), 0.43);
    assert.match(await page.locator(".quick-saved-preset").first().textContent(), /Modified/);
    await page.fill("#quick-temperature-input", "0.8125");
    assert.equal(await page.locator("#quick-temperature-input").evaluate(el => el.validity.valid), true);
    await page.fill("#quick-temperature-input", "");
    assert.equal(await page.evaluate(() => flagCore.getFlagValues().temperature), undefined);
    assert.equal(await page.locator(".quick-saved-preset").first().getAttribute("aria-pressed"), "false", "clearing an explicit setting does not substitute a GUI default in preset comparisons");
    await page.fill("#quick-temperature-input", "0.8");
    assert.equal(await page.locator(".quick-saved-preset").first().getAttribute("aria-pressed"), "true", "reverting inputs restores the preset match");
    await page.fill("#quick-top-p-input", "0.73");
    assert.equal(await page.inputValue("#chat-slider-top-p"), "0.73");
    await page.locator("#quick-server-settings > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#quick-port").isVisible(), true);
    await page.fill("#quick-port", "9050");
    assert.equal(await page.evaluate(() => flagCore.getFlagValues().port), 9050);
    assert.match(await page.textContent("#quick-server-summary"), /Port 9050/);
    assert.ok((await page.textContent("#quick-command-preview")).includes("--port 9050"));
    await page.locator("#quick-server-settings > summary").click();
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".quick-runtime").scrollIntoViewIfNeeded();
    const launchBottom = await page.locator(".quick-launch-bar").evaluate(el => el.getBoundingClientRect().bottom);
    assert.ok(launchBottom < 1000, `common launch controls and action fit a desktop viewport (bottom: ${launchBottom})`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const selector of ["#btn-quick-launch", "#btn-quick-change-models-folder", "#quick-command-details > summary"]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 391, `${selector} fits the narrow viewport`);
    }
    await page.setViewportSize(viewport);
    activeRuntime = { generation: 401, tool: "llama-server", model: "running-model.gguf", host: "127.0.0.1", port: 8080, backend: "vulkan", version: "b12345" };
    await page.evaluate(s => processLifecycle.restore(s, { startOutput: () => {}, startStats: () => {}, postReady: () => {} }), status());
    assert.match(await page.textContent("#quick-runtime-model"), /running-model.gguf.*8080/);
    assert.equal(await page.textContent(".quick-endpoint-label"), "Active endpoint");
    assert.match(await page.textContent("#quick-server-summary"), /9050/, "pending port stays distinct from the running endpoint");
    await page.check('input[name="quick-launch-mode"][value="llama-cli"]');
    assert.equal(await page.locator("#quick-server-fields").isVisible(), false);
    assert.equal(await page.textContent("#btn-quick-launch-label"), "Launch terminal");
    assert.equal(await page.textContent("#btn-quick-stop-label"), "Stop server", "stop labels the active process");
    await page.click("#btn-quick-download");
    assert.equal(await page.locator(".hf-download-panel").evaluate(el => el.open), true);
    assert.equal(await page.locator("#hf-repo-input").evaluate(el => el === document.activeElement), true);
    entries = [];
    await page.evaluate(() => quickLaunchUi.refreshSavedPresets());
    assert.match(await page.textContent("#quick-presets-status"), /Save a launch preset/);
    failPresets = true;
    await page.evaluate(() => quickLaunchUi.refreshSavedPresets());
    assert.match(await page.textContent("#quick-presets-status"), /Could not refresh presets/);
    activeRuntime = null;
    await page.evaluate(() => processLifecycle.restore({ running: false, active_runtime: null }));
    for (const [url, handler] of Object.entries(routes)) await page.unroute(url, handler);
}

async function verifyConfigureRestart(page) {
    await selectSection(page, "configure");
    const baseStatus = await page.evaluate(() => fetchJson("/api/status"));
    await page.evaluate(async () => {
        const core = window.LlamaGui.flagCore;
        core.setCurrentTool("llama-server");
        core.applyFlagValues(getDefaultValues());
        await refreshModels();
    });
    await page.selectOption("#model-select", "smoke-model.gguf");
    const baseline = await page.evaluate(() => window.LlamaGui.flagCore.captureLaunchSettings());
    let runtime = { generation: 301, tool: "llama-server", model: "models/smoke-model.gguf", host: "127.0.0.1", port: 8080, launch_settings: baseline };
    let preflightError = "";
    let refuseStop = false;
    let preflightGate = null;
    const events = [];
    const launches = [];
    const routes = {
        "**/api/status": async route => route.fulfill({ json: { ...baseStatus, running: Boolean(runtime), active_process_tool: runtime?.tool, active_runtime: runtime } }),
        "**/api/llama/health?*": async route => route.fulfill({ json: { state: "ready", ready: true, generation: runtime?.generation } }),
        "**/api/output?*": async route => route.fulfill({ json: { lines: [], running: Boolean(runtime), runtime_generation: runtime?.generation, next_cursor: 0 } }),
        "**/api/launch/preflight": async route => {
            events.push("preflight");
            assert.equal(route.request().postDataJSON().fingerprint_data.tool, "llama-server");
            if (preflightGate) await preflightGate;
            await route.fulfill({ json: preflightError ? { error: preflightError } : { ok: true } });
        },
        "**/api/stop": async route => {
            events.push("stop");
            assert.equal(route.request().postDataJSON().expected_generation, runtime.generation);
            if (!refuseStop) runtime = null;
            await route.fulfill({ json: { stopped: !refuseStop } });
        },
        "**/api/launch": async route => {
            events.push("launch");
            assert.equal(runtime, null, "restart must confirm stop before launching");
            const request = route.request().postDataJSON();
            launches.push(request);
            runtime = { generation: 302, tool: "llama-server", model: "models/smoke-model.gguf", host: "127.0.0.1", port: 8080, launch_settings: request.launch_settings };
            await route.fulfill({ json: { pid: 302, output_cursor: 0, active_runtime: runtime } });
        },
    };
    for (const [url, handler] of Object.entries(routes)) await page.route(url, handler);
    await page.evaluate(activeRuntime => processLifecycle.restore({ running: true, active_runtime: activeRuntime }, {
        startOutput: () => {}, startStats: () => {}, postReady: () => {},
    }), runtime);
    await page.fill("#config-search", "context & memory");
    await page.waitForSelector("#flag-ctx_size", { state: "visible" });
    const button = page.locator("#config-restart");
    assert.equal(await button.isEnabled(), true);
    await page.fill("#flag-ctx_size", "16000");
    await page.fill("#custom-launch-args", '--threads "unfinished');
    await button.click();
    await page.waitForSelector("#config-restart-error:not(.hidden)");
    assert.deepEqual(events, [], "invalid custom arguments must not reach stop or preflight");
    await page.fill("#custom-launch-args", "");
    preflightError = "Local model file does not exist.";
    await button.click();
    await page.waitForSelector("#config-restart-error:not(.hidden)");
    assert.match(await page.textContent("#config-restart-error"), /Local model/);
    assert.deepEqual(events, ["preflight"]);
    preflightError = "";
    refuseStop = true;
    await button.click();
    await page.waitForFunction(() => document.getElementById("config-restart-error").textContent.includes("refused to stop"));
    assert.equal(launches.length, 0, "a refused stop must not launch a second process");
    assert.equal(await button.isEnabled(), true);
    refuseStop = false;
    events.length = 0;
    let releasePreflight;
    preflightGate = new Promise(resolve => { releasePreflight = resolve; });
    await button.click();
    await page.waitForFunction(() => document.getElementById("config-restart").disabled);
    await page.evaluate(() => document.getElementById("config-restart").click());
    await page.fill("#flag-ctx_size", "32000");
    releasePreflight();
    await page.waitForFunction(() => processLifecycle.getSnapshot().activeRuntime?.generation === 302 && !processLifecycle.getSnapshot().busy);
    assert.deepEqual(events, ["preflight", "stop", "launch"], "double activation must still produce only one restart");
    assert.equal(launches[0].launch_settings.flags.ctx_size, 16000, "the preflighted snapshot is the one launched");
    assert.ok(launches[0].args.flat().includes("16000"));
    assert.equal(await page.inputValue("#flag-ctx_size"), "32000", "edits made during restart remain pending");
    assert.equal(await page.locator('.flag-row[data-flag-id="ctx_size"] .flag-baseline-value').textContent(), "16000");
    assert.equal(await button.textContent(), "Restart with changes");
    assert.equal(await page.locator("#config-restart-error").isVisible(), false);
    await page.evaluate(() => window.LlamaGui.flagCore.setCurrentTool("llama-cli"));
    assert.equal(await button.isVisible(), false, "restart is available only for the local server tool");
    await page.evaluate(async () => {
        stopOutputPolling(); stopStatsPolling();
        await processLifecycle.restore({ running: false, active_runtime: null });
    });
    assert.equal(await button.isVisible(), false, "no restart button is offered without a local runtime");
    for (const [url, handler] of Object.entries(routes)) await page.unroute(url, handler);
}

async function verifyShellPolish(page) {
    await page.evaluate(() => document.querySelectorAll("#toast-container .toast").forEach(toast => toast.remove()));
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const sections = ["quick-launch", "configure", "monitor", "benchmarking", "chat", "api", "presets", "install"];
    assert.deepEqual(await page.locator("#sidebar .nav-item").evaluateAll(items => items.map(el => el.dataset.section)), sections);
    assert.deepEqual(await page.locator(".nav-section-label").allTextContents(), ["Tune", "Interact", "Library"]);
    for (const section of sections) {
        await selectSection(page, section);
        assert.equal(await page.locator('#sidebar [aria-current="page"]').getAttribute("data-section"), section);
    }

    const baseStatus = await page.evaluate(() => fetchJson("/api/status"));
    let runtime = { tool: "llama-server", generation: 501, model: "folder/" + "long-model-".repeat(20) + "<img>.gguf", host: "127.0.0.1", port: 8091, backend: "vulkan", version: "b501" };
    let target = null;
    let releaseStop;
    let stops = 0;
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    const status = () => ({ ...baseStatus, running: Boolean(runtime), active_runtime: runtime, active_process_tool: runtime?.tool, external_chat_target: target });
    const routes = {
        "**/api/status": route => route.fulfill({ json: status() }),
        "**/api/llama/health?*": route => route.fulfill({ json: { ready: true, state: "ready", generation: runtime?.generation } }),
        "**/api/output?*": route => route.fulfill({ json: { lines: [], running: Boolean(runtime), runtime_generation: runtime?.generation, next_cursor: 0 } }),
        "**/api/stop": async route => {
            stops += 1;
            assert.equal(route.request().postDataJSON().expected_generation, 501);
            await stopGate;
            runtime = null;
            await route.fulfill({ json: { stopped: true } });
        },
    };
    for (const [url, handler] of Object.entries(routes)) await page.route(url, handler);
    await page.evaluate(s => processLifecycle.restore(s, { startOutput: () => {}, startStats: () => {}, postReady: () => {} }), status());
    assert.equal(await page.textContent("#sidebar-runtime-state"), "Ready");
    assert.equal(await page.getAttribute("#sidebar-runtime-model", "title"), runtime.model);
    assert.equal(await page.locator("#sidebar-runtime img").count(), 0);
    await page.evaluate(() => {
        flagCore.setCurrentTool("llama-cli");
        flagCore.setFlagValue("port", 9999);
    });
    assert.equal(await page.textContent("#btn-sidebar-stop-label"), "Stop server");
    await page.locator("#sidebar-runtime > summary").click();
    assert.match(await page.textContent("#sidebar-runtime-build"), /vulkan.*b501/);
    assert.match(await page.textContent("#sidebar-runtime-endpoint"), /8091/);
    await page.click("#btn-sidebar-runtime-details");
    assert.equal(await page.locator("#section-monitor").isVisible(), true);
    await page.click("#btn-sidebar-stop");
    await page.waitForFunction(() => document.getElementById("sidebar-runtime-state").textContent === "Stopping");
    assert.equal(await page.locator("#btn-sidebar-stop").isDisabled(), true);
    await page.evaluate(() => document.getElementById("btn-sidebar-stop").click());
    assert.equal(stops, 1, "a second Stop cannot run during the transition");
    releaseStop();
    await page.waitForFunction(() => document.getElementById("sidebar-runtime-state").textContent === "Stopped");
    assert.equal(await page.textContent("#btn-sidebar-launch-label"), "Launch terminal");
    target = { connected: true, host: "127.0.0.2", port: 9001, label: "Remote workstation" };
    await page.evaluate(() => refreshRuntimeStatusPanels());
    assert.equal(await page.textContent("#sidebar-runtime-state"), "External server");
    assert.match(await page.textContent("#sidebar-runtime-endpoint"), /9001/);
    await page.click("#btn-sidebar-runtime-details");
    assert.equal(await page.locator("#section-api").isVisible(), true);
    assert.equal(await page.locator("#btn-sidebar-stop").isVisible(), false);
    target = null;
    await page.evaluate(() => refreshRuntimeStatusPanels());
    await page.locator("#sidebar-runtime > summary").click();

    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForTimeout(250);
    assert.equal(await page.locator("#sidebar").evaluate(el => el.inert), true);
    await page.click("#mobile-toggle");
    assert.equal(await page.getAttribute("#mobile-toggle", "aria-expanded"), "true");
    assert.equal(await page.locator(".main-content").evaluate(el => el.inert), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "sidebar-close");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "btn-sidebar-stop-app");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sidebar-close");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement.id), "mobile-toggle");
    await page.click("#mobile-toggle");
    await page.click('.sidebar-maintenance [data-section="install"]');
    assert.equal(await page.locator("#section-install").isVisible(), true);
    assert.equal(await page.getAttribute("#mobile-toggle", "aria-expanded"), "false");
    assert.equal(await page.locator(".main-content").evaluate(el => el.inert), false);
    await page.click("#mobile-toggle");
    await page.click("#sidebar-backdrop", { position: { x: 350, y: 100 } });
    assert.equal(await page.getAttribute("#mobile-toggle", "aria-expanded"), "false");
    await page.click("#mobile-toggle");
    await page.click("#btn-sidebar-stop-app");
    assert.equal(await page.textContent("#confirm-modal-title"), "Quit Llama GUI");
    await page.click("#confirm-modal-cancel");
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    assert.equal(await page.locator("#sidebar").evaluate(el => el.inert), false);
    await page.evaluate(() => { stopOutputPolling(); stopStatsPolling(); });
    for (const [url, handler] of Object.entries(routes)) await page.unroute(url, handler);
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

async function verifyMonitorRuntimePolish(page) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const baseStatus = await page.evaluate(() => fetchJson("/api/status"));
    const baseline = await page.evaluate(() => {
        flagCore.setCurrentTool("llama-server");
        flagCore.setMultipleFlagValues({ ctx_size: 8000, port: 8091 });
        return flagCore.captureLaunchSettings();
    });
    let runtime = { tool: "llama-server", generation: 601, model: "models/" + "long-model-".repeat(25) + "<img>.gguf", host: "127.0.0.1", port: 8091, backend: "vulkan", version: "b601", launch_settings: baseline };
    let target = null;
    const status = () => ({ ...baseStatus, running: Boolean(runtime), active_runtime: runtime, active_process_tool: runtime?.tool, external_chat_target: target });
    const routes = {
        "**/api/status": route => route.fulfill({ json: status() }),
        "**/api/llama/health?*": route => route.fulfill({ json: { state: "ready", ready: true, generation: runtime?.generation } }),
        "**/api/output?*": route => route.fulfill({ json: { lines: [], running: Boolean(runtime), runtime_generation: runtime?.generation, next_cursor: 0 } }),
        "**/api/system-stats*": route => route.fulfill({ json: {
            sampled_at: Date.now() / 1000,
            system: { cpu: { available: true, percent: 12 }, memory: { available: true, used_bytes: 4e9, total_bytes: 16e9, percent: 25 }, disk: { available: true, percent: 50 } },
            gpus: [], gpu_setup: [{ provider: "nvidia", state: "setup_required", message: "nvidia-smi was not found." }],
        } }),
    };
    for (const [url, handler] of Object.entries(routes)) await page.route(url, handler);
    try {
        await page.evaluate(s => processLifecycle.restore(s, { startOutput: () => {}, startStats: () => {}, postReady: () => {} }), status());
        await selectSection(page, "monitor");
        await page.waitForFunction(() => document.getElementById("monitor-cpu-value").textContent === "12.0%");
        assert.equal(await page.textContent("#monitor-runtime-state"), "Ready");
        assert.equal(await page.getAttribute("#monitor-runtime-model", "title"), runtime.model);
        assert.equal(await page.locator(".monitor-runtime img").count(), 0);
        assert.match(await page.textContent("#monitor-runtime-build"), /vulkan.*b601/);
        await page.evaluate(() => flagCore.setMultipleFlagValues({ ctx_size: 16000, port: 9999 }));
        assert.equal(await page.textContent("#btn-monitor-review"), "Review changes · 2");
        assert.match(await page.textContent("#monitor-runtime-endpoint"), /8091/);
        await page.click("#btn-monitor-review");
        assert.equal(await page.locator("#section-configure").isVisible(), true);
        assert.equal(await page.locator("#config-change-review").evaluate(el => el.open), true);
        assert.equal(await page.locator("#config-change-review > summary").evaluate(el => el === document.activeElement), true);
        await selectSection(page, "monitor");
        const gpuHelp = page.locator("#monitor-gpu-help");
        // The disclosure may have been opened by the earlier Monitor check.
        if (await gpuHelp.evaluate(el => el.open)) await gpuHelp.locator("summary").click();
        assert.equal(await page.locator("#monitor-setup-cards").isVisible(), false);
        assert.equal(await page.locator("#monitor-inference-card").isVisible(), true);
        assert.match(await page.textContent("#monitor-gpu-summary"), /unavailable/);
        await gpuHelp.locator("summary").focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#btn-monitor-recheck").isVisible(), true);
        assert.match(await page.textContent("#monitor-setup-cards"), /nvidia-smi/);
        await page.click("#btn-monitor-recheck");
        await page.waitForTimeout(100);
        assert.equal(await gpuHelp.evaluate(el => el.open), true);
        assert.equal(await page.locator("#btn-monitor-recheck").evaluate(el => el === document.activeElement), true);
        await page.locator('[data-monitor-key="state:nvidia"] .monitor-hide-btn').click();
        await gpuHelp.locator("summary").click();
        await page.locator("#monitor-hidden-controls > summary").click();
        await page.locator("#monitor-restore-items button").first().click();
        assert.equal(await gpuHelp.evaluate(el => el.open), true, "restoring a guidance card reveals its disclosure");
        assert.equal(await page.locator('#monitor-gpu-help').evaluate(el => el.contains(document.activeElement)), true);
        for (const width of [900, 390]) {
            await page.setViewportSize({ width, height: 844 });
            assert.equal(await page.locator("#section-monitor").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `Monitor fits at ${width}px`);
            assert.equal(await page.locator(".monitor-runtime button").evaluateAll(buttons => buttons.every(button => {
                const r = button.getBoundingClientRect();
                return !r.width || (r.left >= 0 && r.right <= innerWidth);
            })), true);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        runtime = null;
        await page.evaluate(async () => {
            await processLifecycle.restore({ running: false, active_runtime: null });
            monitorUi.appendOutputLine("retained output");
        });
        assert.equal(await page.textContent("#monitor-output-title"), "Last run output");
        await page.click("#btn-clear-output");
        assert.equal(await page.locator("#output-terminal").isVisible(), false);
        assert.equal(await page.locator("#btn-monitor-quick-launch").isVisible(), true);
        target = { connected: true, host: "127.0.0.1", port: 9008 };
        await page.evaluate(() => checkStatus());
        assert.equal(await page.textContent("#monitor-runtime-state"), "External server");
        assert.match(await page.textContent("#monitor-runtime-endpoint"), /9008/);
        assert.equal(await page.locator("#btn-monitor-review").isVisible(), false);
        await page.click("#btn-monitor-api");
        assert.equal(await page.locator("#section-api").isVisible(), true);

        // Force delayed responses to ignore AbortSignal: epoch validation must
        // still reject the old connection after reconnecting to the same URL.
        const staleResult = await page.evaluate(async () => {
            stopStatsPolling();
            const originalFetch = window.fetch;
            const pending = [];
            window.fetch = (url, options) => String(url).includes("/api/llama/metrics") || String(url).includes("/api/llama/slots")
                ? new Promise(resolve => pending.push(() => resolve({ ok: true,
                    text: async () => "llamacpp:prompt_tokens_total 99999\nllamacpp:tokens_predicted_total 99999",
                    json: async () => [{ id: 0, is_processing: true, n_ctx: 1000, n_prompt_tokens: 999 }],
                }))) : originalFetch(url, options);
            try {
                reconcileInferenceTarget(latestStatus);
                const oldPoll = pollStats();
                markExternalTargetChanged();
                reconcileInferenceTarget(latestStatus);
                pending.forEach(release => release());
                await oldPoll;
                const snapshot = inferenceStats.getSnapshot();
                return { seq: snapshot.seq, context: snapshot.context, total: snapshot.session.total };
            } finally {
                window.fetch = originalFetch;
                stopStatsPolling();
            }
        });
        assert.deepEqual(staleResult, { seq: 1, context: null, total: null });
    } finally {
        runtime = null;
        target = null;
        await page.evaluate(async () => { stopOutputPolling(); stopStatsPolling(); await checkStatus(); });
        for (const [url, handler] of Object.entries(routes)) await page.unroute(url, handler);
    }
}

async function verifySecondaryPagePolish(page) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
        localStorage.removeItem("llama_gui_chat_history_collapsed");
        localStorage.removeItem("llama_gui_chat_settings_collapsed");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.LlamaGui?.chatUi);
    await selectSection(page, "chat");
    const panels = [
        ["chat-history-panel", "btn-open-history", "btn-collapse-history"],
        ["chat-sidebar", "btn-open-sidebar", "btn-collapse-sidebar"],
    ];
    for (const [panel, open, close] of panels) {
        assert.equal(await page.locator(`#${panel}`).isVisible(), false, "new users start with room for the conversation");
        assert.equal(await page.locator(`#${panel}`).evaluate(el => el.inert), true);
        await page.locator(`#${open}`).click();
        assert.equal(await page.locator(`#${panel}`).isVisible(), true);
        assert.equal(await page.locator(`#${close}`).evaluate(el => el === document.activeElement), true);
    }
    await page.setViewportSize({ width: 760, height: 900 });
    for (const [panel] of panels) await page.waitForSelector(`#${panel}`, { state: "hidden" });
    assert.equal(await page.locator("#btn-open-sidebar").evaluate(el => el === document.activeElement), true,
        "responsive collapse moves focus out of hidden controls");
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const [panel] of panels) await page.waitForSelector(`#${panel}`, { state: "visible" });
    assert.equal(await page.locator("#btn-collapse-sidebar").evaluate(el => el === document.activeElement), true,
        "restoring the panel keeps focus on a visible control");
    await page.locator("#btn-chat-focus").click();
    await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 1);
    for (const [panel, open, close] of panels) {
        assert.equal(await page.locator(`#${panel}`).isVisible(), false);
        assert.equal(await page.locator(`#${panel}`).evaluate(el => el.inert), true);
        assert.equal(await page.locator(`#${open}`).isVisible(), true, "panel buttons remain available in focus mode");
        await page.locator(`#${open}`).press("Enter");
        assert.equal(await page.locator(`#${panel}`).isVisible(), true);
        assert.equal(await page.locator(`#${panel}`).evaluate(el => el.inert), false);
        assert.equal(await page.locator(`#${open}`).getAttribute("aria-expanded"), "true");
        assert.equal(await page.locator(`#${close}`).evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator("#btn-chat-focus").getAttribute("aria-pressed"), "true",
            "opening a panel keeps focus mode active");
        assert.ok(await page.locator(".sidebar").evaluate(el => el.getBoundingClientRect().right <= 0),
            "main navigation stays off screen");
        await page.locator(`#${close}`).press("Enter");
        assert.equal(await page.locator(`#${panel}`).isVisible(), false);
        assert.equal(await page.locator(`#${open}`).evaluate(el => el === document.activeElement), true);
    }
    await page.locator("#btn-chat-focus").click();
    for (const [panel] of panels) assert.equal(await page.locator(`#${panel}`).isVisible(), true,
        "focus-mode panel choices do not overwrite the normal expanded preference");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.LlamaGui?.chatUi);
    await selectSection(page, "chat");
    for (const [panel, open, close] of panels) {
        assert.equal(await page.locator(`#${panel}`).isVisible(), true, "panel preference survives reload");
        await page.locator(`#${close}`).click();
        assert.equal(await page.locator(`#${open}`).evaluate(el => el === document.activeElement), true);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.LlamaGui?.chatUi);
    await selectSection(page, "chat");
    for (const [panel] of panels) assert.equal(await page.locator(`#${panel}`).isVisible(), false);
    await page.locator("#btn-chat-focus").click();
    for (const [panel, open] of panels) {
        await page.locator(`#${open}`).click();
        assert.equal(await page.locator(`#${panel}`).isVisible(), true);
    }
    await page.locator("#btn-chat-focus").click();
    for (const [panel] of panels) assert.equal(await page.locator(`#${panel}`).isVisible(), false,
        "exiting focus mode restores the normal collapsed preference");
    await page.locator("#btn-open-sidebar").click();
    const samplerHelp = page.locator(".chat-settings-help");
    assert.equal(await samplerHelp.locator("dl").isVisible(), false);
    await samplerHelp.locator("summary").press("Enter");
    assert.equal(await samplerHelp.locator("dl").isVisible(), true);
    await page.locator('label[for="chat-slider-temp"]').click();
    assert.equal(await page.locator("#chat-slider-temp").evaluate(el => el === document.activeElement), true);
    await page.locator("#btn-collapse-sidebar").click();

    await selectSection(page, "api");
    assert.equal(await page.locator("#api-endpoints-list > li").count(), 6);
    assert.equal(await page.locator("#api-endpoints-list button[aria-label]").count(), 6);
    assert.equal(await page.locator("#btn-connect-external-server").isVisible(), false);
    assert.equal(await page.locator("#btn-start-remote-tunnel").isVisible(), false);
    await page.locator("#api-remote-details > summary").press("Enter");
    assert.equal(await page.locator("#remote-tunnel-warning").isVisible(), true);
    assert.equal(await page.locator("#btn-start-remote-tunnel").isVisible(), true);
    await page.locator("#api-external-details > summary").press("Enter");
    assert.equal(await page.locator("#external-server-host").isVisible(), true);
    await page.locator("#api-snippet-0 > summary").click();
    await page.locator("#api-snippet-1 > summary").click();
    await page.evaluate(() => window.LlamaGui.flagCore.setFlagValue("alias", "polish model"));
    assert.equal(await page.locator("#api-snippet-0").evaluate(el => el.open), false);
    assert.equal(await page.locator("#api-snippet-1").evaluate(el => el.open), true);
    for (const width of [1440, 900, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const overflow = await page.locator("#section-api").evaluate(root => [...root.querySelectorAll("input, button, code, summary")]
            .filter(el => el.getClientRects().length && el.getBoundingClientRect().width && el.getBoundingClientRect().right > innerWidth + 1)
            .map(el => el.id || el.className));
        assert.deepEqual(overflow, [], `API controls and code fit ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await selectSection(page, "install");
    const installed = await page.evaluate(() => {
        const status = { ...latestStatus, installed: true, config_stale: false, version: "polish-test",
            executables: { "llama-cli.exe": true, "llama-server.exe": false, "llama-bench.exe": true, "llama-optional<test>.exe": false } };
        updateStatusUI(status);
        const details = document.querySelector("#installed-optional-tools");
        const summary = details.querySelector("summary");
        details.open = true;
        summary.focus();
        updateStatusUI({ ...status, running: !status.running });
        const result = {
            optional: details.querySelector(".exe-optional")?.textContent,
            required: document.querySelector("#installed-info .exe-missing")?.textContent,
            summary: summary.textContent,
            focusKept: document.activeElement === summary,
            nodeKept: details === document.querySelector("#installed-optional-tools"),
            unsafeElements: document.querySelectorAll("#installed-info test").length,
        };
        updateStatusUI({ ...status, version: "polish-test-2" });
        result.openKept = document.querySelector("#installed-optional-tools").open;
        updateStatusUI({ ...status, installed: false, config_stale: true, missing_runtime_files: ["required.dll"] });
        result.warning = document.querySelector(".installed-info-warning")?.textContent;
        updateStatusUI(latestStatus);
        return result;
    });
    assert.equal(installed.optional, "Not installed");
    assert.equal(installed.required, "Missing · required");
    assert.match(installed.summary, /1 of 2 installed/);
    assert.equal(installed.nodeKept && installed.focusKept && installed.openKept, true);
    assert.equal(installed.unsafeElements, 0);
    assert.match(installed.warning, /required.*runtime libraries are missing/);
    await selectSection(page, "quick-launch");
}

async function verifyChatResponsiveLayout(page) {
    await page.setViewportSize({ width: 1385, height: 1232 });
    await page.evaluate(() => {
        localStorage.removeItem("llama_gui_chat_history_collapsed");
        localStorage.removeItem("llama_gui_chat_settings_collapsed");
        const transcript = Array.from({ length: 80 }, (_, index) =>
            `Layout regression paragraph ${index + 1}: populated transcript content remains readable while panels change size.`
        ).join("\n\n");
        localStorage.setItem("llama_gui_conversations", JSON.stringify([{
            id: "layout-regression",
            title: "Responsive layout regression",
            messages: [
                { role: "user", content: "Check the responsive chat layout." },
                { role: "assistant", content: transcript, status: "complete" },
            ],
            timestamp: Date.now(),
        }]));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.LlamaGui?.chatUi);
    await selectSection(page, "chat");
    await page.locator("#btn-open-history").evaluate((element) => element.click());
    await page.waitForFunction(() => !document.querySelector("#chat-history-panel")?.classList.contains("collapsed"));
    await page.locator("#chat-history-list .chat-history-item").first().click();
    await page.waitForFunction(() => document.querySelectorAll("#chat-messages .chat-message").length >= 2);

    const setPanelState = async (panelId, openId, closeId, open) => {
        const currentlyOpen = await page.locator(`#${panelId}`).evaluate((element) => !element.classList.contains("collapsed"));
        if (currentlyOpen !== open) await page.locator(`#${open ? openId : closeId}`).evaluate((element) => element.click());
        await page.waitForFunction(({ id, expected }) => {
            const element = document.getElementById(id);
            return Boolean(element) && !element.classList.contains("collapsed") === expected;
        }, { id: panelId, expected: open });
    };
    const panelStates = {
        history: ["chat-history-panel", "btn-open-history", "btn-collapse-history"],
        settings: ["chat-sidebar", "btn-open-sidebar", "btn-collapse-sidebar"],
    };
    const readLayout = () => page.evaluate(() => {
        const read = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
                left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                width: rect.width, height: rect.height,
                visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
                clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
            };
        };
        const intersects = (left, right) => Boolean(left?.visible && right?.visible
            && left.left < right.right && left.right > right.left
            && left.top < right.bottom && left.bottom > right.top);
        const layout = read("#chat-layout");
        const main = read(".chat-main");
        const composer = read(".chat-input-area");
        const history = read("#chat-history-panel");
        const historyList = read("#chat-history-list");
        const settings = read("#chat-sidebar");
        const messages = read("#chat-messages");
        const context = read("#chat-tools");
        return {
            layout, main, composer, history, historyList, settings, messages, context,
            intersections: {
                historyMain: intersects(history, main),
                settingsMain: intersects(settings, main),
                historyComposer: intersects(history, composer),
                settingsComposer: intersects(settings, composer),
            },
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: innerHeight,
        };
    });
    const responsiveViewports = [
        { width: 1385, height: 1232 },
        { width: 390, height: 844 },
        { width: 900, height: 720 },
        { width: 1440, height: 915 },
    ];
    for (const viewport of responsiveViewports.flatMap(size => [size, { ...size, focus: true }])) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        if ((await page.locator("#btn-chat-focus").getAttribute("aria-pressed") === "true") !== Boolean(viewport.focus)) {
            await page.locator("#btn-chat-focus").click();
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        for (const state of ["closed", "history", "settings", "both"]) {
            await setPanelState(...panelStates.history, state === "history" || state === "both");
            await setPanelState(...panelStates.settings, state === "settings" || state === "both");
            const layout = await readLayout();
            assert.equal(layout.history.visible, state === "history" || state === "both");
            assert.equal(layout.settings.visible, state === "settings" || state === "both");
            assert.equal(layout.main.visible, true, `chat main remains visible at ${viewport.width}px (${state})`);
            assert.equal(layout.intersections.historyMain, false, `history does not overlap chat main at ${viewport.width}px (${state})`);
            assert.equal(layout.intersections.settingsMain, false, `settings does not overlap chat main at ${viewport.width}px (${state})`);
            assert.equal(layout.intersections.historyComposer, false, `history does not overlap composer at ${viewport.width}px (${state})`);
            assert.equal(layout.intersections.settingsComposer, false, `settings does not overlap composer at ${viewport.width}px (${state})`);
            assert.ok(layout.composer.height > 0 && layout.composer.bottom <= layout.main.bottom + 1,
                `composer stays inside chat main at ${viewport.width}px (${state})`);
            assert.ok(layout.composer.bottom <= layout.documentHeight + 1,
                `composer remains reachable in the document at ${viewport.width}px (${state})`);
            assert.ok(layout.messages.clientHeight > 0 && layout.messages.scrollHeight > layout.messages.clientHeight,
                `populated transcript remains internally scrollable at ${viewport.width}px (${state})`);
            if (layout.history.visible) {
                assert.ok(layout.historyList.clientHeight >= 32,
                    `visible history keeps a reachable conversation list at ${viewport.width}px (${state})`);
            }
            if (state === "both" && (viewport.width === 390 || viewport.width === 900)) {
                assert.ok(layout.messages.clientHeight >= 80,
                    `both-open stacked layout reserves at least 80px of transcript space at ${viewport.width}px (received ${layout.messages.clientHeight}px)`);
            }
            await page.getByRole("button", { name: "Context", exact: true }).click();
            await page.locator("#chat-context-details summary").press("Enter");
            const expanded = await readLayout();
            assert.ok(expanded.context.height > 30 && expanded.context.bottom <= expanded.composer.top,
                `expanded Context stays above the composer at ${viewport.width}px (${state})`);
            assert.ok(expanded.messages.bottom <= expanded.context.top + 1 && expanded.messages.clientHeight > 0,
                `expanded Context reserves space below the transcript at ${viewport.width}px (${state})`);
            assert.ok(Math.abs(expanded.composer.height - layout.composer.height) <= 1
                && Math.abs((expanded.main.bottom - expanded.composer.bottom) - (layout.main.bottom - layout.composer.bottom)) <= 1,
                "opening Context keeps the composer anchored at the bottom of Chat");
            await page.locator("#btn-chat-send").scrollIntoViewIfNeeded();
            assert.equal(await page.locator("#btn-chat-send").evaluate(send => {
                const rect = send.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return hit === send || send.contains(hit);
            }), true, `Context does not cover Send at ${viewport.width}px (${state})`);
            await page.getByRole("button", { name: "Context", exact: true }).click();
            assert.equal(await page.locator("#chat-tools").isVisible(), false, "Context toggles closed");
        }
    }

    for (const width of [1024, 1100]) {
        await page.setViewportSize({ width, height: 720 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await setPanelState(...panelStates.history, true);
        await setPanelState(...panelStates.settings, true);
        await page.evaluate(() => {
            const messages = document.getElementById("chat-messages");
            messages.scrollTop = 0;
            messages.dispatchEvent(new Event("scroll"));
        });
        await page.waitForSelector("#btn-chat-jump-latest:not([hidden])");
        const hitTest = await page.evaluate(() => {
            const send = document.getElementById("btn-chat-send");
            const jump = document.getElementById("btn-chat-jump-latest");
            const sendRect = send.getBoundingClientRect();
            const jumpRect = jump.getBoundingClientRect();
            const hit = document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2);
            return {
                sendVisible: sendRect.width > 0 && sendRect.height > 0,
                jumpVisible: jumpRect.width > 0 && jumpRect.height > 0,
                sendHit: hit === send || send.contains(hit),
                separated: sendRect.right <= jumpRect.left || jumpRect.right <= sendRect.left
                    || sendRect.bottom <= jumpRect.top || jumpRect.bottom <= sendRect.top,
            };
        });
        assert.equal(hitTest.sendVisible, true, `Send remains visible at ${width}px with Jump shown`);
        assert.equal(hitTest.jumpVisible, true, `Jump remains visible at ${width}px with transcript scrolled away`);
        assert.equal(hitTest.sendHit, true, `Send remains hit-testable at ${width}px with Jump shown`);
        assert.equal(hitTest.separated, true, `Jump does not cover Send at ${width}px`);
    }
}

async function verifyCharacterCards(page) {
    const baseStatus = await page.evaluate(() => fetchJson("/api/status"));
    await page.route("**/api/llama/health?*", route => route.fulfill({ json: { state: "ready", ready: true, generation: 700 } }));
    await page.route("**/api/status", route => route.fulfill({ json: { ...baseStatus,
        running: true, active_process_tool: "llama-server", runtime_generation: 700,
        active_runtime: { tool: "llama-server", model: "smoke-model.gguf", generation: 700 },
    } }));
    await page.evaluate(() => localStorage.setItem("llama_gui_conversations", JSON.stringify([
        { id: "original", title: "Original chat", systemPrompt: "Original system prompt", messages: [{ role: "user", content: "Keep this conversation" }] },
    ])));
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectSection(page, "chat");
    await page.locator("#btn-open-history").click();
    await page.getByText("Original chat", { exact: true }).click();
    await page.locator("#btn-chat-focus").click();
    await page.locator("#btn-open-sidebar").click();
    const completions = [];
    page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/chat/completions") completions.push(request.postDataJSON());
    });
    const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"), page.getByRole("button", { name: "Load character card", exact: true }).press("Enter"),
    ]);
    await chooser.setFiles({ name: "eloise.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(character)) });
    await page.waitForFunction(() => document.getElementById("chat-character-status").textContent.startsWith("Started a chat"));
    assert.equal(completions.length, 0, "import must not send a chat request");
    assert.match(await page.locator("#chat-system-prompt").inputValue(), /Éloïse is an astronomer/);
    assert.match(await page.locator("#chat-messages").textContent(), /Hello User, I'm Éloïse/);
    assert.equal(await page.locator("#chat-character-file").inputValue(), "", "the same file can be selected again");
    assert.equal(await page.locator("body").evaluate(el => el.classList.contains("chat-focus-mode")), true);
    const firstImport = await page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations")));
    assert.equal(firstImport.length, 2);
    assert.equal(firstImport.find(c => c.id === "original").systemPrompt, "Original system prompt");

    await page.setInputFiles("#chat-character-file", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{bad") });
    await page.waitForFunction(() => document.getElementById("chat-character-status").textContent.includes("invalid JSON"));
    assert.equal(await page.locator("#chat-system-prompt").inputValue(), firstImport[0].systemPrompt);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations"))), firstImport);

    const pngData = { spec: "chara_card_v3", spec_version: "3.0", data: {
        ...character, name: "PNG explorer", description: "Studies the Moon.", first_mes: "Hello <img src=x onerror=alert(1)>",
    } };
    await page.setInputFiles("#chat-character-file", { name: "card.png", mimeType: "image/png", buffer: pngCard([["ccv3", JSON.stringify(pngData)]]) });
    await page.waitForFunction(() => document.getElementById("chat-character-status").textContent.includes("Started a chat with PNG explorer"));
    assert.equal(await page.locator("#chat-messages img").count(), 0, "card greeting HTML is rendered as text");
    assert.match(await page.locator("#chat-messages").textContent(), /<img src=x/);
    assert.equal(completions.length, 0);
    const pngPrompt = await page.locator("#chat-system-prompt").inputValue();
    await page.fill("#chat-input", "Tell me about the Moon");
    await page.locator("#btn-chat-send").click();
    await page.waitForFunction(() => document.querySelectorAll(".chat-message.assistant").length === 2
        && !document.getElementById("btn-chat-send").disabled);
    assert.equal(completions[0].messages[0].content, pngPrompt);
    assert.equal(completions[0].messages[1].content, pngData.data.first_mes);
    assert.equal(completions[0].messages[2].content, "Tell me about the Moon");
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectSection(page, "chat");
    await page.locator("#btn-open-history").click();
    await page.getByText("PNG explorer", { exact: true }).click();
    assert.equal(await page.locator("#chat-system-prompt").inputValue(), pngPrompt);
    await page.getByText("Original chat", { exact: true }).click();
    assert.equal(await page.locator("#chat-system-prompt").inputValue(), "Original system prompt");
    for (const width of [390, 900]) {
        await page.setViewportSize({ width, height: 844 });
        if (!await page.locator("#chat-sidebar").isVisible()) await page.locator("#btn-open-sidebar").click();
        await page.locator("#btn-chat-load-character").scrollIntoViewIfNeeded();
        const bounds = await page.locator("#btn-chat-load-character").boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `character loader fits at ${width}px`);
    }
}

async function verifyChatDeletion(page) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
        localStorage.setItem("llama_gui_conversations", JSON.stringify(["Alpha", "Beta", "Gamma", "Delta"].map(title => ({
            id: title, title, systemPrompt: `${title} prompt`, messages: [{ role: "user", content: `${title} message` }],
        }))));
        localStorage.setItem("llama_gui_deleted_conversations", JSON.stringify([{ id: "old", title: "Old deleted", messages: [] }]));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectSection(page, "chat");
    await page.locator("#btn-open-history").click();
    await page.getByText("Alpha", { exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Restore deleted", exact: true }).count(), 0);
    const readIds = () => page.evaluate(() => JSON.parse(localStorage.getItem("llama_gui_conversations")).map(c => c.id));
    const modal = page.locator("#confirm-modal");
    const confirm = page.locator("#confirm-modal-ok");
    const cancel = page.locator("#confirm-modal-cancel");
    const betaDelete = page.locator(".chat-history-item").filter({ hasText: "Beta" }).getByRole("button", { name: "Delete conversation", exact: true });
    await betaDelete.click();
    assert.equal(await page.locator("#confirm-modal-title").textContent(), "Delete Conversation");
    assert.match(await page.locator("#confirm-modal-message").textContent(), /Beta.*cannot be undone/);
    assert.deepEqual(await readIds(), ["Alpha", "Beta", "Gamma", "Delta"]);
    await cancel.press("Enter");
    assert.equal(await modal.isVisible(), false);
    assert.deepEqual(await readIds(), ["Alpha", "Beta", "Gamma", "Delta"], "Enter on Cancel must not confirm deletion");
    await betaDelete.click();
    await page.keyboard.press("Escape");
    assert.equal(await modal.isVisible(), false);
    assert.deepEqual(await readIds(), ["Alpha", "Beta", "Gamma", "Delta"]);
    await betaDelete.click();
    await confirm.press("Enter");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("llama_gui_conversations")).length === 3);
    assert.equal(await modal.isVisible(), false);
    assert.deepEqual(await readIds(), ["Alpha", "Gamma", "Delta"]);
    assert.equal(await page.locator("#chat-system-prompt").inputValue(), "Alpha prompt", "deleting another conversation keeps the active chat");

    await page.locator("#btn-chat-clear").click();
    assert.equal(await page.locator("#confirm-modal-title").textContent(), "Clear Current Chat");
    await cancel.click();
    assert.match(await page.locator("#chat-messages").textContent(), /Alpha message/);
    await page.locator("#btn-chat-clear").click();
    await confirm.click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("llama_gui_conversations")).length === 2);
    assert.equal(await modal.isVisible(), false, "Clear must not open a second delete confirmation");
    assert.deepEqual(await readIds(), ["Gamma", "Delta"]);
    assert.equal(await page.locator("#chat-messages .chat-message").count(), 0);
    assert.equal(await page.locator("#chat-system-prompt").inputValue(), "");

    await page.getByText("Gamma", { exact: true }).click();
    await page.locator("#btn-delete-all-history").click();
    assert.equal(await page.locator("#confirm-modal-title").textContent(), "Delete All Conversations");
    await cancel.click();
    assert.deepEqual(await readIds(), ["Gamma", "Delta"]);
    await page.locator("#btn-delete-all-history").click();
    await confirm.click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("llama_gui_conversations")).length === 0);
    assert.equal(await modal.isVisible(), false, "one confirmation deletes the entire saved list");
    assert.equal(await page.locator("#chat-messages .chat-message").count(), 0);
    await page.locator("#btn-chat-new").click();
    assert.deepEqual(await readIds(), [], "New Chat must not resurrect a deleted conversation");
    assert.equal(await page.getByRole("button", { name: "Restore deleted", exact: true }).count(), 0);
}

async function verifyBenchmarkActions(page) {
    const baseStatus = await page.evaluate(() => fetchJson("/api/status"));
    let runtime = null;
    let generation = 600;
    let lines = [];
    let launchError = "";
    let refuseStop = false;
    let wikitextError = false;
    const launches = [];
    const stops = [];
    await page.route("**/api/status", route => route.fulfill({ json: {
        ...baseStatus, running: Boolean(runtime), active_runtime: runtime,
        active_process_tool: runtime?.tool || "", runtime_generation: generation,
    } }));
    await page.route("**/api/output*", route => {
        const cursor = Number(new URL(route.request().url()).searchParams.get("since") || 0);
        return route.fulfill({ json: {
            lines: lines.slice(cursor), next_cursor: lines.length, dropped: false,
            running: Boolean(runtime), runtime_generation: generation,
            active_process_tool: runtime?.tool || "",
        } });
    });
    await page.route("**/api/launch", route => {
        const body = route.request().postDataJSON();
        launches.push(body);
        if (launchError) return route.fulfill({ status: 400, json: { error: launchError } });
        generation += 1;
        runtime = { generation, tool: body.tool, model: "models/smoke-model.gguf" };
        lines = [];
        return route.fulfill({ json: { pid: generation, active_runtime: runtime, output_cursor: 0 } });
    });
    await page.route("**/api/stop", route => {
        stops.push(route.request().postDataJSON());
        if (!refuseStop) runtime = null;
        return route.fulfill({ json: { stopped: !refuseStop } });
    });
    await page.route("**/api/benchmark/wikitext2", route => {
        assert.equal(route.request().method(), "POST");
        return route.fulfill(wikitextError
            ? { status: 500, json: { error: "Dataset unavailable" } }
            : { json: { path: "benchmarks/wiki.test.raw", downloaded: true } });
    });
    await selectSection(page, "benchmarking");
    await page.selectOption("#benchmark-source", "manual");
    await page.selectOption("#benchmark-manual-model", "smoke-model.gguf");
    const run = page.locator("#btn-run-benchmark");
    const stop = page.locator("#btn-stop-benchmark");
    const output = page.locator("#benchmark-output-terminal");

    await run.click();
    await page.waitForFunction(() => window.LlamaGui.processLifecycle.getSnapshot().phase === "running");
    assert.equal(launches[0].tool, "llama-bench");
    assert.ok(launches[0].args.some(arg => arg[0] === "-m" && arg[1] === "models/smoke-model.gguf"));
    assert.equal(await run.isVisible(), false);
    assert.equal(await stop.isVisible(), true);
    lines = ["prefill 123.45 ± 1.00 t/s", "generation 67.89 t/s", "<img src=x onerror=alert(1)>"];
    await page.waitForFunction(() => document.querySelector("#benchmark-summary").textContent.includes("67.89 t/s"));
    assert.equal(await page.textContent("#benchmark-summary"), "Throughput observed: 123.45 t/s, 67.89 t/s");
    assert.equal(await output.locator("img").count(), 0);
    runtime = null;
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("process exited"));
    assert.equal(await run.isVisible(), true);
    assert.equal(await stop.isVisible(), false);

    launchError = "Benchmark executable missing";
    await run.click();
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("ERROR:"));
    assert.match(await output.textContent(), /Benchmark executable missing/);
    assert.equal(await run.isVisible(), true);
    launchError = "";
    await run.click();
    await page.waitForFunction(() => window.LlamaGui.processLifecycle.getSnapshot().phase === "running");
    refuseStop = true;
    await stop.click();
    await page.waitForFunction(() => window.LlamaGui.processLifecycle.getSnapshot().phase === "failed"
        && !window.LlamaGui.processLifecycle.getSnapshot().busy);
    assert.match(await output.textContent(), /Stop request failed/);
    assert.equal(stops.at(-1).expected_generation, runtime.generation);
    assert.equal(await stop.isVisible(), true, "a refused stop keeps the process controllable");
    assert.equal(await run.isVisible(), false);
    lines.push("Output continues after refused stop");
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("Output continues"));
    refuseStop = false;
    await stop.click();
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("Benchmark stopped"));

    runtime = { generation: ++generation, tool: "llama-bench", model: "models/smoke-model.gguf" };
    lines = ["restored throughput 42 t/s"];
    await page.evaluate(() => checkStatus());
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("Reconnected to running llama-bench"));
    assert.equal(await stop.isVisible(), true, "accepted status updates must adopt an external benchmark launch");
    await page.reload();
    await selectSection(page, "benchmarking");
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("Reconnected to running llama-bench"));
    await page.waitForFunction(() => document.querySelector("#benchmark-summary").textContent.includes("42 t/s"));
    assert.equal(await stop.isVisible(), true);
    await stop.click();
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("Benchmark stopped"));

    await page.selectOption("#benchmark-type", "perplexity");
    await page.selectOption("#benchmark-manual-model", "smoke-model.gguf");
    assert.equal(await run.isDisabled(), true, "perplexity requires a dataset");
    const prepare = page.locator("#btn-benchmark-wikitext-clean");
    wikitextError = true;
    await prepare.click();
    await page.waitForFunction(() => document.querySelector("#toast-container").textContent.includes("Dataset unavailable"));
    assert.equal(await prepare.isDisabled(), false, "failed preparation can be retried");
    assert.equal(await page.inputValue("#benchmark-prompt-file"), "");
    wikitextError = false;
    await prepare.click();
    await page.waitForFunction(() => document.querySelector("#benchmark-prompt-file").value === "benchmarks/wiki.test.raw");
    assert.equal(await page.inputValue("#benchmark-ppl-preset"), "clean");
    await run.click();
    await page.waitForFunction(() => window.LlamaGui.processLifecycle.getSnapshot().phase === "running");
    assert.deepEqual(launches.at(-1), {
        tool: "llama-perplexity", args: [["-m", "models/smoke-model.gguf"], ["-f", "benchmarks/wiki.test.raw"]],
    });
    await stop.click();
    await page.waitForFunction(() => document.querySelector("#benchmark-output-terminal").textContent.includes("Benchmark stopped"));
}

async function runScenario(browser, port, verify) {
    const page = await browser.newPage();
    try {
        const chatCompletionBodies = [];
        const chatCompletionHeaders = [];
        const launchBodies = [];
        const metricsHeaders = [];
        const slotsHeaders = [];
        const pageErrors = [];
        const releaseRequests = [];
        const activateCustomRequests = [];
        let custom02Ready = false;
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
                    io_available: true,
                    io_label: "All physical disks",
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
                        version: installedBackend.startsWith("custom") ? "custom" : "smoke",
                        tag: installedBackend.startsWith("custom") ? "custom" : "smoke",
                        official_install: { backend: "cpu", tag: "smoke", version: "smoke", files_present: true },
                        available_backends: [
                            { id: "cpu", label: "CPU" },
                            { id: "custom", label: "Custom", custom: true, bin_dir: "llama/custom/bin/" },
                            { id: "custom-02", label: "Custom 02", custom: true, bin_dir: "llama/custom-02/bin/" },
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
                const requested = JSON.parse(route.request().postData() || "{}");
                activateCustomRequests.push(requested);
                if (requested.backend === "custom-02" && !custom02Ready) {
                    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
                        ok: false, missing_required: ["llama-server"],
                    }) });
                    return;
                }
                installedBackend = requested.backend || "custom";
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
            if (pathName === "/api/install") {
                const requested = JSON.parse(route.request().postData() || "{}");
                assert.equal(requested.activate_existing, true);
                installedBackend = requested.backend;
                await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
                    ok: true, tag: "smoke", backend: installedBackend,
                }) });
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
                    `llamacpp:prompt_seconds_total ${statsMetrics.promptSeconds}`,
                    `llamacpp:prompt_tokens_seconds ${statsMetrics.promptSpeed}`,
                    `llamacpp:tokens_predicted_total ${statsMetrics.genTokens}`,
                    `llamacpp:tokens_predicted_seconds_total ${statsMetrics.genSeconds}`,
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

        if (verify) {
            await verify(page);
            assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
            return;
        }

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

        await selectSection(page, "quick-launch");

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

        await page.locator("#quick-starter-profiles > summary").click();
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
        await verifyConfigurePresentation(page);
        await verifyNgramSimple(page);
        await verifyReasoningPreserve(page);

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
            // Settle Quick Launch's status refresh before manual sampling: the
            // stopped-server fixture would otherwise clear the stats target.
            await refreshRuntimeStatusPanels();
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
            promptSeconds: 2,
            promptSpeed: 11,
            genTokens: 500,
            genSeconds: 10,
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
            id: 1, id_task: 76, n_ctx: 1000, is_processing: true,
            n_prompt_tokens: 700, n_prompt_tokens_cache: 600,
            n_prompt_tokens_processed: 100, next_token: [{ n_decoded: 0 }],
        }];
        await page.evaluate(() => pollStats());
        await wait(1100);
        statsSlots[0].n_prompt_tokens_processed = 400;
        statsSlots[0].n_prompt_tokens = 1000;
        await page.evaluate(() => pollStats());
        const livePromptSpeed = await page.textContent("#stats-prompt-speed");
        assert.ok(Number(livePromptSpeed) > 0, "prompt speed updates before completed counters advance");
        assert.equal(await page.textContent("#monitor-inference-prompt-speed"), `${livePromptSpeed} tok/s`);
        assert.equal(await page.textContent("#monitor-inference-prompt-speed-label"), "Live prompt speed");
        assert.equal(await page.textContent("#stats-prompt-speed-label"), "tok/s prompt live");
        assert.equal(await page.textContent("#stats-prompt-tokens"), "0");
        await page.evaluate(() => pollStats());
        assert.equal(await page.textContent("#stats-prompt-speed"), livePromptSpeed,
            "an unchanged prompt batch retains the measured average");
        assert.equal(await page.textContent("#monitor-inference-prompt-speed"), `${livePromptSpeed} tok/s`);
        statsSlots[0].next_token[0].n_decoded = 1;
        statsMetrics.promptTokens = 1400;
        statsMetrics.promptSeconds = 4;
        await page.evaluate(() => pollStats());
        assert.equal(await page.textContent("#stats-prompt-speed"), "200.0");
        assert.equal(await page.textContent("#monitor-inference-prompt-speed"), "200.0 tok/s");
        assert.equal(await page.textContent("#monitor-inference-prompt-speed-label"), "Avg prompt speed");
        assert.equal(await page.textContent("#stats-prompt-speed-label"), "tok/s prompt avg");

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
        const liveGenSpeed = await page.textContent("#stats-gen-speed");
        assert.ok(Number(liveGenSpeed) > 0, "live speed updates before completion counters advance");
        assert.equal(await page.textContent("#monitor-inference-gen-speed"), `${liveGenSpeed} tok/s`,
            "the Monitor card shares the fixed bar's live rate");
        assert.equal(await page.textContent("#monitor-inference-gen-speed-label"), "Live generation speed");
        assert.equal(await page.textContent("#stats-gen-speed-label"), "tok/s gen live");
        assert.equal(await page.textContent("#stats-context"), "400",
            "session tokens stay baseline-relative while slot context moves independently");
        statsMetrics.genTokens = 530;
        statsMetrics.genSeconds = 12;
        statsMetrics.processing = 0;
        statsSlots = idleStatsSlots;
        await page.evaluate(() => pollStats());
        assert.equal(await page.textContent("#stats-gen-speed"), "15.0", "idle preserves the average");
        assert.equal(await page.textContent("#monitor-inference-gen-speed-label"), "Avg generation speed");
        assert.equal(await page.textContent("#stats-gen-speed-label"), "tok/s gen avg");
        delete statsMetrics.genSeconds;
        await page.evaluate(() => pollStats());
        assert.equal(await page.textContent("#stats-gen-speed"), "--", "missing time does not use a gauge");
        assert.equal(await page.textContent("#monitor-inference-gen-speed"), "--");

        await page.evaluate(() => stopStatsPolling());
        assert.equal(metricsHeaders.at(-1).authorization, "Bearer first-secret");
        assert.equal(slotsHeaders.at(-1).authorization, "Bearer first-secret");

        // A failed Stop leaves the same llama-server alive. Recovery must pass
        // its runtime through startStatsPolling so inference polling resumes.
        statusRunning = true;
        activeProcessTool = "llama-server";
        statusActiveRuntime = {
            tool: "llama-server", generation: 42, model: "models/smoke-model.gguf", backend: "cpu", version: "b9999",
            launch_settings: await page.evaluate(() => window.LlamaGui.flagCore.captureLaunchSettings()),
        };
        stopShouldFail = true;
        await page.evaluate(async (activeRuntime) => {
            await processLifecycle.restore({
                running: true,
                active_process_tool: "llama-server",
                active_runtime: activeRuntime,
            }, { startOutput: () => {}, postReady: () => {} });
            await stopLlama();
        }, statusActiveRuntime);
        assert.equal(await page.evaluate(() => inferenceStats.getTargetKey()), "gui:42");
        assert.equal(
            await page.locator("#stats-bar").evaluate((el) => el.classList.contains("hidden")),
            false,
            "failed Stop recovery must keep the fixed stats bar active",
        );
        await page.evaluate(() => stopOutputPolling());
        await verifyConfigureComparison(page);
        stopShouldFail = false;
        statusRunning = false;
        activeProcessTool = "";
        statusActiveRuntime = null;
        await page.evaluate(() => stopStatsPolling());
        await page.evaluate(() => refreshRuntimeStatusPanels());
        assert.equal(await page.locator("#config-changes-only").isDisabled(), true, "stopping clears the comparison baseline");

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
                    - document.querySelector(".chat-main").getBoundingClientRect().right);
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
        statusActiveRuntime = { tool: "llama-cli", generation: 43 };
        await page.evaluate(() => refreshRuntimeStatusPanels());
        assert.equal(await page.locator("#chat-input").isDisabled(), true);
        activeProcessTool = "llama-server";
        statusActiveRuntime = { tool: "llama-server", generation: 44 };
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
        if (await page.locator("#chat-sidebar").evaluate(el => el.classList.contains("collapsed"))) {
            await page.locator("#btn-open-sidebar").click();
            await page.waitForFunction(() => !document.querySelector("#chat-sidebar")?.classList.contains("collapsed"));
        }
        const advancedSamplers = page.locator(".chat-advanced-samplers");
        if (!await advancedSamplers.evaluate(el => el.open)) await advancedSamplers.locator(":scope > summary").click();
        const samplerBeforeExactEntry = await page.evaluate(() => {
            const values = window.LlamaGui.flagCore.getFlagValues();
            return { temperature: values.temperature, top_p: values.top_p };
        });
        await page.fill("#chat-num-temp", "2.5");
        await page.dispatchEvent("#chat-num-temp", "change");
        await page.fill("#chat-num-top-p", "1.5");
        await page.dispatchEvent("#chat-num-top-p", "change");
        await page.waitForFunction(() => {
            const values = window.LlamaGui.flagCore.getFlagValues();
            return values.temperature === 2.5 && values.top_p === 1.5;
        });
        assert.equal(await page.locator("#chat-num-temp").inputValue(), "2.5");
        assert.equal(await page.locator("#chat-num-top-p").inputValue(), "1.5");
        assert.equal(await page.locator("#chat-slider-temp").inputValue(), "2",
            "the temperature slider is a clamped visual proxy for an exact numeric value");
        assert.equal(await page.locator("#chat-slider-top-p").inputValue(), "1",
            "the Top-P slider is a clamped visual proxy for an exact numeric value");
        await page.click("#btn-chat-new");
        await page.fill("#chat-input", "Numeric sampler request");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        assert.equal(chatCompletionBodies.at(-1).temperature, 2.5);
        assert.equal(chatCompletionBodies.at(-1).top_p, 1.5);
        await page.evaluate(({ temperature, top_p }) => {
            window.LlamaGui.flagCore.setMultipleFlagValues({ temperature, top_p });
        }, samplerBeforeExactEntry);
        await page.waitForFunction(({ temperature, top_p }) => {
            const values = window.LlamaGui.flagCore.getFlagValues();
            return values.temperature === temperature && values.top_p === top_p;
        }, samplerBeforeExactEntry);
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
        await page.evaluate(() => {
            const originalFetch = window.fetch;
            let controller = null;
            let closed = false;
            const encoder = new TextEncoder();
            const emit = (payload) => {
                if (!controller || closed) return;
                const data = typeof payload === "string" ? payload : JSON.stringify(payload);
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            };
            window.__pushStagedChatChunk = emit;
            window.__finishStagedChatStream = () => {
                emit("[DONE]");
                if (controller && !closed) {
                    closed = true;
                    controller.close();
                }
            };
            window.__restoreStagedChatFetch = () => {
                window.fetch = originalFetch;
                delete window.__pushStagedChatChunk;
                delete window.__finishStagedChatStream;
                delete window.__restoreStagedChatFetch;
            };
            window.fetch = (url, options = {}) => {
                if (!String(url).includes("/api/chat/completions")) return originalFetch(url, options);
                const stream = new ReadableStream({
                    start(nextController) {
                        controller = nextController;
                        closed = false;
                        emit({ choices: [{ delta: {
                            content: "First staged response " + "staged-token ".repeat(600),
                        } }] });
                        options.signal?.addEventListener("abort", () => {
                            if (!closed) {
                                closed = true;
                                controller.error(new DOMException("Aborted", "AbortError"));
                            }
                        }, { once: true });
                    },
                });
                return Promise.resolve(new Response(stream, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                }));
            };
        });
        await page.fill("#chat-input", "Staged streaming response");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("First staged response"));
        const scrolledAway = await page.evaluate(() => {
            const container = document.getElementById("chat-messages");
            const maxScroll = container.scrollHeight - container.clientHeight;
            if (maxScroll <= 80) throw new Error("staged response did not create a scrollable transcript");
            container.scrollTop = Math.max(0, maxScroll - 240);
            if (maxScroll - (container.scrollTop + container.clientHeight) <= 80) container.scrollTop = 0;
            container.dispatchEvent(new Event("scroll"));
            return {
                top: container.scrollTop,
                maxScroll,
                clientHeight: container.clientHeight,
            };
        });
        assert.ok(scrolledAway.maxScroll - (scrolledAway.top + scrolledAway.clientHeight) > 80,
            "the staged reader is scrolled away from the latest response");
        await page.evaluate(() => window.__pushStagedChatChunk({
            choices: [{ delta: { reasoning_content: "Later reasoning chunk" } }],
        }));
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Later reasoning chunk"));
        assert.equal(await page.evaluate(() => document.querySelector("#chat-messages").scrollTop), scrolledAway.top,
            "later reasoning preserves an away-from-bottom reader position");
        await page.evaluate(() => window.__pushStagedChatChunk({
            choices: [{ delta: { content: "Later content chunk" } }],
        }));
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Later content chunk"));
        assert.equal(await page.evaluate(() => document.querySelector("#chat-messages").scrollTop), scrolledAway.top,
            "later content and reasoning preserve an away-from-bottom reader position");
        assert.equal(await page.locator("#btn-chat-jump-latest").isVisible(), true,
            "Jump to latest stays available while a reader is scrolled away");
        await page.evaluate(() => {
            window.__pushStagedChatChunk({ choices: [{ delta: {}, finish_reason: "stop" }] });
            window.__pushStagedChatChunk({
                choices: [],
                usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 },
                timings: { predicted_per_second: 12.5 },
            });
        });
        await page.evaluate(() => window.__finishStagedChatStream());
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        assert.equal(await page.locator("#btn-chat-jump-latest").isVisible(), true,
            "Jump to latest remains available after a completed away-from-bottom stream");
        const stagedMetadata = await page.locator(".chat-response-metadata").last().innerText();
        assert.match(stagedMetadata, /Prompt: 13/);
        assert.match(stagedMetadata, /Completion: 7/);
        assert.match(stagedMetadata, /Total: 20/);
        assert.match(stagedMetadata, /Speed: 12\.5 tok\/s/);
        assert.match(stagedMetadata, /Stop: Finished/);
        assert.doesNotMatch(stagedMetadata, /Stop: stop/i);
        assert.match(await page.locator(".chat-reasoning-body").last().textContent(), /Later reasoning chunk/);

        await page.locator("#btn-chat-jump-latest").click();
        assert.equal(await page.locator("#btn-chat-jump-latest").isVisible(), false,
            "Jump to latest resumes follow mode");
        await page.click("#btn-chat-new");
        await page.fill("#chat-input", "Follow after jump");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("First staged response"));
        const followScroll = await page.evaluate(() => {
            const container = document.getElementById("chat-messages");
            const maxScroll = container.scrollHeight - container.clientHeight;
            if (maxScroll <= 80) throw new Error("follow response did not create a scrollable transcript");
            container.scrollTop = 0;
            container.dispatchEvent(new Event("scroll"));
            return { top: container.scrollTop, maxScroll, clientHeight: container.clientHeight };
        });
        assert.ok(followScroll.maxScroll - (followScroll.top + followScroll.clientHeight) > 80);
        await page.locator("#btn-chat-jump-latest").click();
        await page.evaluate(() => window.__pushStagedChatChunk({
            choices: [{ delta: { content: "Final followed chunk" } }],
        }));
        await page.waitForFunction(() => document.querySelector("#chat-messages")?.textContent.includes("Final followed chunk"));
        await page.waitForFunction(() => {
            const container = document.querySelector("#chat-messages");
            return container.scrollHeight - (container.scrollTop + container.clientHeight) <= 80;
        });
        await page.evaluate(() => window.__finishStagedChatStream());
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        assert.equal(await page.locator("#btn-chat-jump-latest").isVisible(), false,
            "a followed stream finishes at the latest response");
        await page.evaluate(() => window.__restoreStagedChatFetch());

        if (!await page.locator("#chat-sidebar").evaluate((element) => element.classList.contains("collapsed"))) {
            await page.click("#btn-collapse-sidebar");
        }
        await page.click("#btn-chat-new");
        chatResponseMode = "ok";
        await page.fill("#chat-input", "Editable prompt");
        await page.click("#btn-chat-send");
        await page.waitForFunction(() => document.querySelector("#btn-chat-send")?.style.display !== "none");
        const editAction = page.getByRole("button", { name: "Edit and resend", exact: true });
        assert.equal(await editAction.count(), 1, "completed user turns expose Edit and resend immediately");
        await editAction.click();
        await page.waitForSelector("#confirm-modal:not(.hidden)");
        await page.click("#confirm-modal-ok");
        await page.waitForSelector("#chat-edit-status:not([hidden])");
        assert.match(await page.locator("#chat-edit-status").innerText(), /history copy.*before edit/i);
        assert.equal(await page.locator("#chat-input").inputValue(), "Editable prompt");
        await page.click("#chat-edit-status .btn");
        await page.waitForSelector("#chat-edit-status[hidden]", { state: "attached" });

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
        await page.waitForFunction(() => document.querySelector(".chat-message.assistant .chat-response-footer")?.textContent.includes("Answer 3 of 3"));
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
        assert.equal(await page.locator("#chat-tools").isVisible(), false, "tabbing outside Context dismisses the panel");
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
        assert.equal(await page.locator(".chat-message.user .chat-bubble").innerText(), "Measure my draft");
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

        // Context and compaction are reached through the composer's Context panel;
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
        await page.locator("#quick-sampling-details > summary").click();
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
        statusActiveRuntime = null;
        await page.evaluate(() => refreshRuntimeStatusPanels());
        assert.equal(await page.textContent("#external-server-badge"), "Not connected");
        assert.equal(
            await page.locator("#external-server-summary").evaluate((el) => el.classList.contains("hidden")),
            true
        );

        await page.locator("#api-external-details > summary").click();
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
        const countCustomReleaseRequests = () => releaseRequests.filter((search) =>
            ["custom", "custom-02"].includes(new URLSearchParams(search).get("backend"))).length;
        const customReleaseCountBefore = countCustomReleaseRequests();
        await page.selectOption("#backend-select", "custom");
        await page.waitForFunction(() => document.querySelector("#custom-backend-info")?.offsetParent !== null);
        await page.waitForFunction(() => document.querySelector("#btn-install")?.textContent === "Activate Custom");
        await page.waitForTimeout(250);
        assert.equal(countCustomReleaseRequests(), customReleaseCountBefore);
        await page.click("#btn-install");
        await page.waitForFunction(() => document.querySelector("#install-status")?.textContent.includes("Custom backend activated"));
        assert.equal(activateCustomRequests.length, 1);
        assert.equal(pageErrors.length, 0, pageErrors.join("\n"));

        const flagsBeforeSwitch = await page.evaluate(() => JSON.stringify(window.LlamaGui.flagCore.getFlagValues()));
        await page.selectOption("#backend-select", "custom-02");
        await page.waitForFunction(() => document.querySelector("#custom-backend-folder")?.textContent === "llama/custom-02/bin/");
        assert.equal(await page.locator("#installed-backend-summary").textContent(), "Installed backend: Custom");
        await page.click("#btn-install");
        await page.waitForFunction(() => document.querySelector("#install-status")?.textContent.includes("Custom 02 needs llama-cli and llama-server"));
        assert.equal(installedBackend, "custom");
        assert.equal(await page.locator("#btn-update").isDisabled(), true);
        custom02Ready = true;
        await page.click("#btn-install");
        await page.waitForFunction(() => document.querySelector("#installed-backend-summary")?.textContent === "Installed backend: Custom 02");
        assert.equal(await page.locator("#version-badge").textContent(), "Custom 02");
        assert.match(await page.locator("#installed-info").textContent(), /llama\/custom-02\/bin\//);
        assert.deepEqual(activateCustomRequests.at(-1), { backend: "custom-02" });
        assert.equal(countCustomReleaseRequests(), customReleaseCountBefore);
        await page.selectOption("#backend-select", "cpu");
        await page.waitForFunction(() => document.querySelector("#btn-install")?.textContent === "Activate Existing");
        await page.click("#btn-install");
        await page.waitForFunction(() => document.querySelector("#installed-backend-summary")?.textContent === "Installed backend: CPU");
        await page.selectOption("#backend-select", "custom");
        await page.click("#btn-install");
        await page.waitForFunction(() => document.querySelector("#installed-backend-summary")?.textContent === "Installed backend: Custom");
        assert.equal(await page.evaluate(() => JSON.stringify(window.LlamaGui.flagCore.getFlagValues())), flagsBeforeSwitch,
            "switching builds must not change shared model/preset flags");

        await selectSection(page, "quick-launch");
        await page.setViewportSize({ width: 1346, height: 674 });
        await page.locator(".sidebar-meta-row").scrollIntoViewIfNeeded();
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
        assert.ok(initialSidebarSlider.footerBottom <= initialSidebarSlider.viewportHeight + 12, "sidebar footer must remain reachable in a short viewport");
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

        const fetchesBeforeAssignment = await page.evaluate(() => window.__modelSwitcherFetchCalls);
        await page.selectOption("#model-switch-select-a", "Refreshed from A");
        await page.waitForFunction(previous => window.__modelSwitcherFetchCalls === previous + 1, fetchesBeforeAssignment);
        assert.deepEqual(await page.evaluate(() => [
            document.querySelector("#model-switch-select-a").value,
            document.querySelector("#model-switch-select-b").value,
        ]), ["Refreshed from A", "Sidebar Model B"], "changing one assignment must survive reload and preserve the other");
        await page.selectOption("#model-switch-select-a", "Sidebar Model A");
        await page.waitForFunction(() => document.querySelector("#sidebar-model-switcher-slider")?.getAttribute("aria-disabled") === "false");

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
        await page.click("#sidebar-model-switcher-thumb");
        assert.equal(await page.evaluate(() => window.__sidebarSwitchCalls), 0, "clicking the thumb without dragging must be inert");

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
        assert.equal(await page.textContent("#monitor-disk-write"), "410 KB/s");
        assert.equal(await page.textContent("#monitor-disk-activity"), "Reading and writing");
        assert.match(await page.textContent("#monitor-disk-sub"), /All physical disks.*Includes other applications/);
        assert.equal(await page.locator("#monitor-disk-value, #monitor-disk-bar").count(), 0, "capacity no longer appears in the activity card");
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
                regularWidths: Array.from(grid.querySelectorAll(':scope > .card:not(.monitor-inference-card)'))
                    .map(card => card.getBoundingClientRect().width),
            };
        });
        assert.equal(wideMonitorLayout.display, "flex");
        assert.equal(wideMonitorLayout.wrap, "wrap");
        assert.ok(wideMonitorLayout.regularWidths.every(width => Math.abs(width - wideMonitorLayout.gpuWidth) < 1),
            "standard Monitor cards keep equal widths across incomplete rows");

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
        await page.locator("#monitor-gpu-help > summary").click();
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
    } finally {
        await page.close();
    }
}

let browser;
let server;
let port;
before(async () => {
    port = await findFreePort(START_PORT);
    server = await startStaticServer(port);
    browser = await loadPlaywright().chromium.launch({ headless: true });
});
after(async () => {
    try {
        if (browser) await browser.close();
    } finally {
        if (server) server.kill();
    }
});

for (const [name, verify] of [
    ["shared controls, chat, downloads and model switcher", null],
    ["configure restart", verifyConfigureRestart],
    ["configure reset to defaults", verifyConfigureReset],
    ["quick launch presentation", verifyQuickLaunchPolish],
    ["navigation and responsive shell", verifyShellPolish],
    ["chat, API and install presentation", verifySecondaryPagePolish],
    ["chat responsive layout bounds", verifyChatResponsiveLayout],
    ["character card import", verifyCharacterCards],
    ["chat deletion confirmations", verifyChatDeletion],
    ["monitor runtime presentation", verifyMonitorRuntimePolish],
    ["preset library", verifyPresetPolish],
    ["benchmark actions and recovery", verifyBenchmarkActions],
]) {
    test(name, { timeout: 120000 }, () => runScenario(browser, port, verify));
}
