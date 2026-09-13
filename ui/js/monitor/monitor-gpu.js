// GPU identity, in-place reconciliation, probe state and setup cards.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    const PROBE_REASON_LABELS = {
        not_found: "Tool not found",
        timeout: "Probe timed out",
        exit_code: "Non-zero exit",
        parse_error: "Unparsable output",
        no_devices: "No usable devices",
        launch_failed: "Could not launch tool",
    };

    const GPU_ICON_SVG = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>';
    const PROVIDER_LABELS = { nvidia: "NVIDIA", amd: "AMD" };
    const GPU_MONITORING_GUIDE_URL = "https://github.com/thomas9120/LLama-GUI/blob/main/docs/gpu-monitoring.md";

    function appendProbeDetailRows(parent, details) {
        if (!details || typeof details !== "object") return;
        const reason = details.reason;
        if (typeof reason !== "string" || !reason) return;
        const wrap = I.dom.makeEl("div", "monitor-probe-details");
        wrap.appendChild(I.dom.makeMetricRow("Reason", "probe-reason"));
        I.dom.updateMetricRow(I.dom.metricRow(wrap, "probe-reason"), PROBE_REASON_LABELS[reason] || reason, false);
        if (typeof details.executable === "string" && details.executable) {
            const row = I.dom.makeMetricRow("Tool", "probe-tool");
            I.dom.updateMetricRow(row, details.executable, false);
            wrap.appendChild(row);
        }
        if (typeof details.exit_code === "number") {
            const row = I.dom.makeMetricRow("Exit code", "probe-exit-code");
            I.dom.updateMetricRow(row, String(details.exit_code), false);
            wrap.appendChild(row);
        }
        if (typeof details.stderr === "string" && details.stderr) {
            const row = I.dom.makeMetricRow("Stderr", "probe-stderr");
            I.dom.updateMetricRow(row, details.stderr, false);
            wrap.appendChild(row);
        }
        parent.appendChild(wrap);
    }

    function cardShell(key, label, kickerText, titleText, iconClass, iconSvg) {
        const card = I.dom.makeEl("div", "card");
        card.dataset.monitorKey = key;
        card.dataset.monitorLabel = label;

        const header = I.dom.makeEl("div", "card-header");
        const heading = I.dom.makeEl("div");
        heading.appendChild(I.dom.makeEl("div", "card-kicker", kickerText));
        heading.appendChild(I.dom.makeEl("div", "card-title", titleText));
        header.appendChild(heading);

        const tools = I.dom.makeEl("div", "monitor-card-tools");
        tools.appendChild(I.preferences.makeDragHandle(label));
        tools.appendChild(I.preferences.makeHideButton(key, label));
        if (iconClass && iconSvg) {
            const iconWrap = I.dom.makeEl("div", `card-icon ${iconClass}`);
            const icon = I.dom.makeEl("span", "icon icon-lg");
            icon.innerHTML = `<svg viewBox="0 0 24 24">${iconSvg}</svg>`;
            iconWrap.appendChild(icon);
            tools.appendChild(iconWrap);
        }
        header.appendChild(tools);
        card.appendChild(header);
        return card;
    }

    function providerLabel(provider) {
        return PROVIDER_LABELS[String(provider || "").toLowerCase()] || String(provider || "GPU");
    }

    function gpuCardKey(gpu) {
        return `gpu:${String(gpu && gpu.id || "")}`;
    }

    function gpuCardName(gpu) {
        return String(gpu && gpu.name || "").trim() || `${providerLabel(gpu && gpu.provider)} GPU`;
    }

    function gpuCardIndex(gpu) {
        return Number.isFinite(Number(gpu && gpu.index)) ? Number(gpu.index) : null;
    }

    function makeGpuCard(gpu) {
        const card = cardShell(gpuCardKey(gpu), "", "", "", "icon-green", GPU_ICON_SVG);
        const utilBlock = I.dom.makeEl("div", "monitor-metric-block");
        utilBlock.appendChild(I.dom.makeMetricRow("Utilization", "utilization"));
        utilBlock.appendChild(I.dom.makeProgressBar("", null));
        card.appendChild(utilBlock);

        const memBlock = I.dom.makeEl("div", "monitor-metric-block");
        memBlock.appendChild(I.dom.makeMetricRow("VRAM", "vram"));
        memBlock.appendChild(I.dom.makeProgressBar("", null));
        card.appendChild(memBlock);

        const meta = I.dom.makeEl("div", "monitor-gpu-meta");
        meta.appendChild(I.dom.makeMetricRow("Temperature", "temperature"));
        meta.appendChild(I.dom.makeMetricRow("GPU ID", "gpu-id"));
        card.appendChild(meta);

        updateGpuCard(card, gpu);
        return card;
    }

    function updateGpuCard(card, gpu) {
        const id = String(gpu && gpu.id || "");
        const index = gpuCardIndex(gpu);
        const name = gpuCardName(gpu);
        const provider = providerLabel(gpu && gpu.provider);
        const label = index === null ? name : `GPU ${index} \u00b7 ${name}`;
        const kicker = index === null ? provider : `GPU ${index} \u00b7 ${provider}`;

        card.dataset.monitorLabel = label;
        I.dom.setText(card.querySelector(".card-kicker"), kicker);
        I.dom.setText(card.querySelector(".card-title"), name);
        const hideBtn = card.querySelector(".monitor-hide-btn");
        if (hideBtn) {
            hideBtn.setAttribute("aria-label", `Hide ${label} monitor`);
            hideBtn.title = `Hide ${label}`;
        }
        const dragHandle = card.querySelector(".monitor-drag-handle");
        if (dragHandle) {
            dragHandle.setAttribute("aria-label", `Move ${label} monitor; use arrow keys`);
            dragHandle.title = `Drag ${label} to reorder; use arrow keys to move`;
        }

        const util = gpu && gpu.utilization_percent;
        const hasUtil = util !== null && util !== undefined;
        I.dom.updateMetricRow(I.dom.metricRow(card, "utilization"),
            hasUtil ? `${I.dom.formatPercentValue(util)}%` : "", !hasUtil);

        const memUsed = gpu && gpu.memory_used_bytes;
        const memTotal = gpu && gpu.memory_total_bytes;
        const hasMemory = memUsed !== null && memUsed !== undefined
            && memTotal !== null && memTotal !== undefined && Number(memTotal) > 0;
        I.dom.updateMetricRow(I.dom.metricRow(card, "vram"),
            hasMemory ? `${I.dom.formatBytes(memUsed)} / ${I.dom.formatBytes(memTotal)}` : "", !hasMemory);

        const temp = gpu && gpu.temperature_c;
        const hasTemp = temp !== null && temp !== undefined;
        I.dom.updateMetricRow(I.dom.metricRow(card, "temperature"),
            hasTemp ? `${Math.round(Number(temp))} \u00b0C` : "", !hasTemp);

        I.dom.updateMetricRow(I.dom.metricRow(card, "gpu-id"), I.dom.shortGpuId(id), !id);
        const idReading = I.dom.metricRow(card, "gpu-id");
        if (idReading) {
            const reading = idReading.querySelector(".monitor-metric-reading");
            if (reading) reading.title = id;
        }

        const bars = card.querySelectorAll(".progress-bar");
        I.dom.updateProgressBar(bars[0], hasUtil ? util : null, `${label} utilization`);
        I.dom.updateProgressBar(bars[1],
            hasMemory ? Number(memUsed) / Number(memTotal) * 100 : null,
            `${label} memory`);
    }

    function makeStateCard(entry) {
        const provider = String(entry && entry.provider || "");
        const unsupported = entry && entry.state === "unsupported";
        const key = provider ? `state:${provider}` : "state:generic";
        const title = provider
            ? unsupported
                ? `${providerLabel(provider)} SMI monitoring unavailable`
                : `${providerLabel(provider)} telemetry unavailable`
            : "No supported GPU telemetry detected";
        const card = I.dom.makeEl("div", "card");
        card.dataset.monitorKey = key;
        card.dataset.monitorLabel = title;

        const tools = I.dom.makeEl("div", "monitor-card-tools");
        tools.style.justifyContent = "flex-end";
        tools.appendChild(I.preferences.makeDragHandle(title));
        tools.appendChild(I.preferences.makeHideButton(key, title));
        card.appendChild(tools);

        const empty = I.dom.makeEl("div", "empty-state");
        empty.appendChild(I.dom.makeEl("div", "empty-state-title", title));
        const message = String(entry && entry.message || "").trim()
            || (provider
                ? `System metrics keep updating. Use the ${providerLabel(provider)} setup card and Recheck when ready.`
                : "No supported vendor tool or GPU backend identified NVIDIA or AMD hardware. System metrics keep updating; Recheck after changing the installed backend or driver environment.");
        empty.appendChild(I.dom.makeEl("p", "", message));
        appendProbeDetailRows(empty, entry && entry.details);
        const guide = I.dom.makeEl("a", "btn btn-sm monitor-setup-guide", "GPU monitoring setup guide");
        guide.href = GPU_MONITORING_GUIDE_URL;
        guide.target = "_blank";
        guide.rel = "noopener noreferrer";
        empty.appendChild(guide);
        card.appendChild(empty);
        return card;
    }

    function makeSetupCard(entry) {
        const provider = String(entry && entry.provider || "");
        const key = `setup:${provider}`;
        const label = `${providerLabel(provider)} monitoring setup`;
        const card = cardShell(
            key,
            label,
            "GPU Monitoring Setup",
            providerLabel(provider),
            provider === "amd" ? "icon-magenta" : "icon-blue",
            GPU_ICON_SVG,
        );

        if (entry.state === "error") {
            card.appendChild(I.dom.makeEl("p", "help-text", String(entry.message || "The vendor probe failed. Check the vendor runtime installation, then Recheck.")));
        } else if (provider === "nvidia") {
            card.appendChild(I.dom.makeEl("p", "help-text", String(entry.message || "nvidia-smi was not found. It ships with the NVIDIA driver environment \u2014 Llama GUI does not install or upgrade drivers. Install or update the driver using the official documentation, then Recheck.")));
        } else {
            if (entry.package_manager) {
                const detected = I.dom.makeMetricRow("Detected", "package-manager");
                I.dom.updateMetricRow(detected, `Linux \u00b7 ${entry.package_manager}`, false);
                card.appendChild(detected);
            }
            card.appendChild(I.dom.makeEl("p", "help-text", String(entry.message || "amd-smi was not found. The AMD repository and a compatible amdgpu driver must already be configured; then install AMD SMI once with the command shown. Llama GUI shows the command but never runs it.")));
            if (entry.command) {
                const row = I.dom.makeEl("div", "monitor-command-row");
                const command = I.dom.makeEl("code", "monitor-command", entry.command);
                row.appendChild(command);
                const copyBtn = I.dom.makeEl("button", "btn btn-sm", "Copy");
                copyBtn.type = "button";
                copyBtn.title = "Copy install command";
                copyBtn.addEventListener("click", () => {
                    const copyText = I.dependencies.copyText;
                    const notify = (message, type) => {
                        if (typeof I.dependencies.showToast === "function") I.dependencies.showToast(message, type);
                    };
                    if (typeof copyText !== "function") {
                        notify("Could not copy command", "error");
                        return;
                    }
                    // copyText resolves to a success flag; only claim a copy
                    // that actually reached the clipboard.
                    Promise.resolve(copyText(entry.command)).then(
                        (copied) => notify(
                            copied ? "Command copied" : "Could not copy command",
                            copied ? "info" : "error",
                        ),
                        (error) => {
                            console.warn("Could not copy install command", error);
                            notify("Could not copy command", "error");
                        },
                    );
                });
                row.appendChild(copyBtn);
                card.appendChild(row);
            }
        }

        if (entry.docs_url) {
            const actions = I.dom.makeEl("div", "form-row");
            actions.style.marginBottom = "0";
            const link = I.dom.makeEl("a", "btn", provider === "nvidia"
                ? "Open NVIDIA driver documentation"
                : "Open AMD SMI installation docs");
            link.href = entry.docs_url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            actions.appendChild(link);
            card.appendChild(actions);
        }
        appendProbeDetailRows(card, entry.details);
        return card;
    }

    function stateCardKey(entry) {
        const provider = String(entry && entry.provider || "");
        return provider ? `state:${provider}` : "state:generic";
    }

    function setupCardKey(entry) {
        return `setup:${String(entry && entry.provider || "")}`;
    }

    function stateCardSignature(entry) {
        return JSON.stringify([
            stateCardKey(entry),
            String(entry && entry.state || ""),
            String(entry && entry.message || ""),
            (entry && entry.details) || null,
        ]);
    }

    function setupCardSignature(entry) {
        return JSON.stringify([
            String(entry && entry.state || ""),
            String(entry && entry.package_manager || ""),
            String(entry && entry.command || ""),
            String(entry && entry.docs_url || ""),
            String(entry && entry.message || ""),
            (entry && entry.details) || null,
        ]);
    }

    function reconcileCards(container, entries, handlers) {
        if (!container) return;
        const { keyOf, signatureOf, create, update, owns = () => true } = handlers;
        const existing = new Map();
        for (const child of Array.from(container.children)) {
            if (!owns(child)) continue;
            const key = child && child.dataset ? child.dataset.monitorKey : null;
            if (key && !existing.has(key)) existing.set(key, child);
        }
        const wanted = new Set();
        const desired = [];
        for (const entry of entries) {
            const key = keyOf(entry);
            wanted.add(key);
            const signature = signatureOf ? signatureOf(entry) : undefined;
            let card = existing.get(key);
            if (card && signature !== undefined && card.dataset.monitorSig !== signature) {
                card.remove();
                card = null;
            }
            if (!card) {
                card = create(entry);
                card.dataset.monitorKey = key;
                if (signature !== undefined) card.dataset.monitorSig = signature;
                container.appendChild(card);
            } else if (update) {
                update(card, entry);
            }
            desired.push(card);
        }
        for (const [key, card] of existing) {
            if (!wanted.has(key)) card.remove();
        }
        // Reorder only where it differs. Re-appending a card removes and
        // re-inserts it, which drops focus and collapses a selection even
        // though the node itself survives.
        const current = Array.from(container.children).filter(owns);
        let inOrder = current.length === desired.length;
        for (let i = 0; inOrder && i < desired.length; i += 1) {
            if (current[i] !== desired[i]) inOrder = false;
        }
        if (!inOrder) {
            for (const card of desired) container.appendChild(card);
        }
    }

    function renderGpuArea(sample) {
        const cardGrid = I.dom.byId("monitor-card-grid");
        const stateWrap = I.dom.byId("monitor-gpu-states");
        const setupSection = I.dom.byId("monitor-gpu-setup");
        const setupCards = I.dom.byId("monitor-setup-cards");
        if (!cardGrid || !stateWrap || !setupSection || !setupCards) return;

        const gpus = Array.isArray(sample && sample.gpus) ? sample.gpus : [];
        const setupEntries = Array.isArray(sample && sample.gpu_setup) ? sample.gpu_setup : [];

        reconcileCards(cardGrid, gpus, {
            keyOf: gpuCardKey,
            create: makeGpuCard,
            update: updateGpuCard,
            owns: card => String(card && card.dataset && card.dataset.monitorKey || "").startsWith("gpu:"),
        });

        // State cards: one per provider whose probe is not working, or the
        // backend's platform-specific generic state. Keep a generic fallback
        // for older backends that do not send that state yet.
        const stateEntries = setupEntries.slice();
        if (gpus.length === 0 && setupEntries.length === 0) stateEntries.push(null);
        reconcileCards(stateWrap, stateEntries, {
            keyOf: stateCardKey,
            signatureOf: stateCardSignature,
            create: makeStateCard,
        });

        // Setup cards exist only for setup_required/error states.
        const actionable = setupEntries.filter(entry =>
            entry.state === "setup_required" || entry.state === "error");
        reconcileCards(setupCards, actionable, {
            keyOf: setupCardKey,
            signatureOf: setupCardSignature,
            create: makeSetupCard,
        });
        setupSection.classList.toggle("hidden", actionable.length === 0);

        I.dom.setText(I.dom.byId("monitor-gpu-summary"), gpus.length
            ? stateEntries.length ? "Some GPU telemetry is unavailable" : `GPU telemetry · ${gpus.length} ${gpus.length === 1 ? "device" : "devices"}`
            : "GPU telemetry is unavailable");

        I.preferences.applyHiddenCardsToDom();
        I.preferences.applyCardOrderToDom();
    }

    I.gpu = {
        renderGpuArea,
    };
})();
