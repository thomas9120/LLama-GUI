// Chat package (5/8): compaction controls, chat tools menu, context budget preview, pre-send auto-compaction.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const { CHAT_AUTO_COMPACTION_STORAGE_KEY } = I.consts;
    const compaction = window.LlamaGui.chatCompaction;

    function getCompactionKey() {
        const status = S.getLatestStatus ? S.getLatestStatus() : null;
        return JSON.stringify([I.getTemplateCapsKey(), status?.active_runtime, status?.external_chat_target,
            I.buildChatBody(S.chatMessages), document.getElementById("chat-input")?.value || ""]);
    }

    function getChatRuntimeKey() {
        const status = S.getLatestStatus ? S.getLatestStatus() : null;
        return JSON.stringify([I.getTemplateCapsKey(), status?.active_runtime, status?.external_chat_target]);
    }

    function updateCompactionControls() {
        const button = document.getElementById("btn-chat-compact");
        if (!button) return;
        const available = compaction.boundary(S.chatMessages) > (S.chatCompactions.at(-1)?.end || 0);
        button.disabled = !S.compactionController && (!available || S.chatStreaming || !I.isServerRunning() || !I.workspaceMutationAllowed());
        button.textContent = S.compactionController ? "Cancel compaction" : "Compact conversation";
        button.title = "Summarize older messages; keep the transcript and last two turns unchanged.";
        for (const id of ["btn-chat-undo-compaction", "btn-chat-tools-undo-compaction"]) {
            const undo = document.getElementById(id);
            if (undo) undo.disabled = !I.workspaceMutationAllowed() || S.chatStreaming || Boolean(S.compactionController);
        }
        for (const id of ["btn-chat-view-summary", "btn-chat-tools-undo-compaction"]) {
            const action = document.getElementById(id);
            if (action) action.hidden = !S.chatCompactions.length;
        }
        const trigger = document.getElementById("btn-chat-tools");
        if (trigger) trigger.title = S.compactionController ? "Compacting conversation — open to cancel" : "Context usage and compaction";
    }

    function renderCompactionMarker() {
        const container = document.getElementById("chat-messages");
        container?.querySelectorAll(".chat-compaction-marker").forEach(el => el.remove());
        const record = S.chatCompactions.at(-1);
        if (!container || !record) return;
        const marker = document.createElement("details");
        marker.className = "chat-compaction-marker";
        const heading = document.createElement("summary");
        heading.textContent = `Earlier ${record.end} messages compacted · View summary`;
        marker.appendChild(heading);
        const note = document.createElement("p");
        note.textContent = "The original messages remain above. Only this summary and the recent messages are sent to the model. Summaries may omit details; review before continuing.";
        marker.appendChild(note);
        const summary = document.createElement("pre");
        summary.textContent = record.summary;
        marker.appendChild(summary);
        const undo = document.createElement("button");
        undo.id = "btn-chat-undo-compaction";
        undo.type = "button";
        undo.className = "btn btn-xs";
        undo.textContent = "Undo compaction";
        undo.addEventListener("click", undoCompaction);
        marker.appendChild(undo);
        container.insertBefore(marker, container.querySelectorAll(".chat-message")[record.end] || null);
    }

    function undoCompaction() {
        if (!I.workspaceMutationAllowed() || S.chatStreaming || S.compactionController || !S.chatCompactions.length) return false;
        if (!I.invalidateWorkspace()) return false;
        const previous = S.chatCompactions.slice();
        S.chatCompactions.pop();
        if (!I.saveCurrentConversation()) {
            S.chatCompactions = previous;
            return false;
        }
        I.requestWorkspaceCheckpoint({ reason: "undo-compaction" });
        renderCompactionMarker();
        updateCompactionControls();
        scheduleContextPreview(true);
        return true;
    }

    function compactConversation(draftOverride = null) {
        if (!I.workspaceMutationAllowed() || S.chatStreaming || S.compactionController || !I.isServerRunning()) return Promise.resolve(false);
        const ownerEpoch = S.workspaceEpoch;
        const controller = new AbortController();
        S.compactionController = controller;
        S.compactionKey = getCompactionKey();
        cancelContextPreview();
        I.updateChatAvailability(I.isServerRunning());
        const status = document.getElementById("chat-compaction-status");
        const report = message => { if (status) { status.textContent = message; status.hidden = !message; } };
        report("Measuring space for a summary…");
        const draft = draftOverride === null ? document.getElementById("chat-input")?.value || "" : draftOverride;
        const pending = (async () => {
            let applied = false;
            try {
                const record = await compaction.compact({
                    messages: S.chatMessages.map(msg => ({ role: msg.role, content: msg.content, reasoning_content: msg.reasoning || msg.reasoning_content, sources: msg.sources, status: msg.status, toolMessages: msg.toolMessages })),
                    previous: S.chatCompactions.at(-1), body: I.buildChatBody(S.chatMessages),
                    draft, signal: controller.signal,
                    headers: S.getApiAuthorizationHeaders({ "Content-Type": "application/json" }), onProgress: report,
                });
                if (controller.signal.aborted || !I.workspaceMutationAllowed(ownerEpoch) || !I.isServerRunning() || S.compactionKey !== getCompactionKey()) {
                    throw Object.assign(new Error("Chat changed"), { name: "AbortError" });
                }
                S.chatCompactions.push(record);
                if (!I.saveCurrentConversation()) {
                    S.chatCompactions.pop();
                    throw new Error("Could not save the compaction.");
                }
                I.requestWorkspaceCheckpoint({ reason: "compaction" });
                renderCompactionMarker();
                report("");
                applied = true;
            } catch (error) {
                console.debug("Chat compaction did not apply", error);
                report(error.name === "AbortError" ? "Compaction cancelled; previous context kept."
                    : `${error.message} Previous context kept. You can retry Compact conversation.`);
            } finally {
                S.compactionController = null;
                S.compactionKey = null;
                I.updateChatAvailability(I.isServerRunning());
                scheduleContextPreview(true);
            }
            return applied;
        })();
        S.compactionPromise = pending;
        pending.then(() => { if (S.compactionPromise === pending) S.compactionPromise = null; });
        return pending;
    }

    function setChatToolsOpen(open, showContext = false, restoreFocus = false) {
        const panel = document.getElementById("chat-tools");
        const trigger = document.getElementById("btn-chat-tools");
        if (!panel || !trigger) return;
        panel.hidden = !open;
        trigger.setAttribute("aria-expanded", String(open));
        const details = document.getElementById("chat-context-details");
        if (details && (!open || showContext)) details.open = open;
        if (open) panel.querySelector("summary")?.focus();
        else if (restoreFocus) trigger.focus();
    }

    function initChatTools() {
        const panel = document.getElementById("chat-tools");
        const trigger = document.getElementById("btn-chat-tools");
        if (!panel || !trigger) return;
        trigger.addEventListener("click", () => setChatToolsOpen(panel.hidden));
        document.getElementById("btn-chat-context-details")?.addEventListener("click", () => setChatToolsOpen(true, true));
        document.getElementById("btn-chat-view-summary")?.addEventListener("click", () => {
            setChatToolsOpen(false);
            const marker = document.querySelector(".chat-compaction-marker");
            if (marker) {
                marker.open = true;
                marker.querySelector("summary")?.focus();
                marker.scrollIntoView({ block: "nearest" });
            }
        });
        document.getElementById("btn-chat-tools-undo-compaction")?.addEventListener("click", () => {
            undoCompaction();
            setChatToolsOpen(false, false, true);
        });
        document.addEventListener("click", event => {
            if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)
                && !document.getElementById("btn-chat-context-details")?.contains(event.target)) setChatToolsOpen(false);
        });
        document.addEventListener("keydown", event => {
            if (event.key === "Escape" && !panel.hidden) {
                event.preventDefault();
                setChatToolsOpen(false, false, true);
            }
        });
        document.addEventListener("focusin", event => {
            if (!panel.hidden && !panel.contains(event.target) && event.target !== trigger) setChatToolsOpen(false);
        });
    }

    function renderContextBudget(budget, bodyKey = null) {
        if (budget && (Number.isFinite(budget.prompt_tokens) || budget.status)) {
            S.latestContextBudget = budget;
            if (bodyKey) S.latestContextBodyKey = bodyKey;
        }
        const label = document.getElementById("chat-context-label");
        const bar = document.getElementById("chat-context-bar");
        const promptFill = document.getElementById("chat-context-prompt");
        const reserveFill = document.getElementById("chat-context-reserve");
        if (!label || !bar || !promptFill || !reserveFill) return;
        const measured = Number.isFinite(budget.prompt_tokens) && budget.capacity > 0;
        const used = measured ? budget.prompt_tokens : 0;
        const reserve = measured && Number.isFinite(budget.reply_reserve) ? budget.reply_reserve : 0;
        const percent = measured ? Math.min(100, 100 * (used + reserve) / budget.capacity) : 0;
        bar.hidden = !measured;
        bar.setAttribute("aria-valuenow", String(Math.round(percent)));
        bar.dataset.status = budget.status;
        promptFill.style.width = `${measured ? Math.min(100, 100 * used / budget.capacity) : 0}%`;
        reserveFill.style.width = `${measured ? Math.max(0, Math.min(100 - 100 * used / budget.capacity, 100 * reserve / budget.capacity)) : 0}%`;
        label.textContent = measured
            ? `${used.toLocaleString()} prompt + ${reserve.toLocaleString()} reply ${budget.reserve_source === "planning" ? "headroom" : "reserved"} / ${budget.capacity.toLocaleString()} tokens. ${Math.max(0, budget.remaining).toLocaleString()} free. ${budget.message || ""}`
            : budget.message || "Context count unavailable.";
        if (budget.search_pending) label.textContent += " Web results are added and checked when you send.";
        if (budget.includes_search) label.textContent += " Includes web results.";
        bar.setAttribute("aria-valuetext", label.textContent);
        const warning = document.getElementById("chat-context-warning");
        const warningText = document.getElementById("chat-context-warning-text");
        if (warning && warningText) {
            warning.hidden = !["warning", "overflow"].includes(budget.status);
            warningText.textContent = budget.status === "overflow"
                ? "This request exceeds the context limit." : "Context is nearly full.";
        }
    }

    function cancelContextPreview() {
        S.contextRevision += 1;
        if (S.contextTimer !== null) clearTimeout(S.contextTimer);
        S.contextTimer = null;
        if (S.contextController) S.contextController.abort();
        S.contextController = null;
    }

    function contextBodyKey(body) {
        return JSON.stringify(body || {});
    }

    function isAutoCompactionEnabled() {
        const toggle = document.getElementById("chat-auto-compact-toggle");
        if (toggle) return Boolean(toggle.checked);
        return I.getStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY) === "true";
    }

    function setAutoCompactionEnabled(enabled, options = {}) {
        if (!I.workspaceMutationAllowed() && options.force !== true) return false;
        const value = Boolean(enabled);
        const toggle = document.getElementById("chat-auto-compact-toggle");
        if (toggle) toggle.checked = value;
        if (options.persist !== false && I.workspaceMutationAllowed()) {
            I.setStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY, String(value));
        }
        I.notifyWorkspaceChange();
        I.requestWorkspaceCheckpoint({ reason: "auto-compaction" });
        return true;
    }

    function ensureAutoCompactionControl() {
        let toggle = document.getElementById("chat-auto-compact-toggle");
        if (!toggle) {
            const compactButton = document.getElementById("btn-chat-compact");
            const parent = compactButton?.parentNode;
            if (!parent || typeof document.createElement !== "function") return null;
            const label = document.createElement("label");
            label.className = "chat-auto-compact-setting";
            toggle = document.createElement("input");
            toggle.type = "checkbox";
            toggle.id = "chat-auto-compact-toggle";
            const text = document.createElement("span");
            text.textContent = "Compact automatically when context is nearly full";
            label.appendChild(toggle);
            label.appendChild(text);
            parent.appendChild(label);
        }
        toggle.checked = I.getStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY) === "true";
        toggle.title = "Before sending, summarize older turns only when the current context preview is near or over capacity.";
        toggle.setAttribute("aria-label", "Compact automatically when context is nearly full");
        if (!toggle.dataset.chatAutoCompactionWired) {
            toggle.dataset.chatAutoCompactionWired = "1";
            toggle.addEventListener("change", () => {
                setAutoCompactionEnabled(toggle.checked);
                scheduleContextPreview(true);
            });
        }
        return toggle;
    }

    function ensureEditStatusControl() {
        if (document.getElementById("chat-edit-status")) return document.getElementById("chat-edit-status");
        const input = document.getElementById("chat-input");
        const parent = input?.parentNode;
        if (!parent || typeof document.createElement !== "function") return null;
        const status = document.createElement("div");
        status.id = "chat-edit-status";
        status.hidden = true;
        const message = document.createElement("span");
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn-xs";
        cancel.textContent = "Cancel edit";
        cancel.addEventListener("click", I.cancelEdit);
        status.appendChild(message);
        status.appendChild(cancel);
        parent.appendChild(status);
        return status;
    }

    function scheduleContextPreview(force = false) {
        if (!document.getElementById("chat-context-label") || !S.flagCore) return;
        if (!I.workspaceMutationAllowed()) {
            cancelContextPreview();
            S.latestContextBudget = null;
            S.latestContextBodyKey = null;
            renderContextBudget({ message: S.workspaceOwned ? "Chat context preview is paused during transfer." : "Chat is open in another window." });
            return;
        }
        const status = S.getLatestStatus ? S.getLatestStatus() : null;
        const body = I.buildChatBody(S.chatMessages, document.getElementById("chat-input")?.value || "");
        const key = JSON.stringify([I.getTemplateCapsKey(), status?.active_runtime,
            status?.external_chat_target, body]);
        if (!force && key === S.contextKey) return;
        S.contextKey = key;
        cancelContextPreview();
        if (S.compactionController) {
            if (!I.isServerRunning() || S.compactionKey !== getCompactionKey()) S.compactionController.abort();
            return;
        }
        if (!I.isServerRunning()) {
            S.latestContextBudget = null;
            S.latestContextBodyKey = null;
            renderContextBudget({ message: "Start or connect to a server to measure context." });
            return;
        }
        if (S.chatStreaming) return;
        if (!body.messages.some(msg => msg.role !== "system" && msg.role !== "developer")) {
            S.latestContextBudget = null;
            S.latestContextBodyKey = null;
            renderContextBudget({ status: "empty", message: "Type a message to measure context." });
            return;
        }
        renderContextBudget({ message: "Measuring context…" });
        const revision = S.contextRevision;
        S.contextTimer = setTimeout(() => {
            S.contextTimer = null;
            void refreshContextPreview(body, revision);
        }, 500);
    }

    async function refreshContextPreview(body, revision) {
        if (!I.workspaceMutationAllowed()) return null;
        const ownerEpoch = S.workspaceEpoch;
        const controller = new AbortController();
        S.contextController = controller;
        try {
            const response = await fetch("/api/chat/context", {
                method: "POST", headers: S.getApiAuthorizationHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify(body), signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const budget = await response.json();
            if (I.workspaceMutationAllowed(ownerEpoch) && revision === S.contextRevision && !S.chatStreaming) {
                renderContextBudget(budget, contextBodyKey(body));
                return budget;
            }
            return null;
        } catch (error) {
            if (error.name !== "AbortError" && revision === S.contextRevision) {
                console.debug("Could not measure chat context", error);
                renderContextBudget({ message: "Context count unavailable; the server will validate the request." });
            }
            return null;
        } finally {
            if (S.contextController === controller) S.contextController = null;
        }
    }

    async function maybeCompactBeforeSend(userText, attemptToken, retry = false, ownerEpoch = S.workspaceEpoch) {
        if (!I.workspaceMutationAllowed(ownerEpoch) || attemptToken !== S.sendAttemptToken) return false;
        if (!isAutoCompactionEnabled() || S.autoCompactionAttempted || S.pendingEdit) return true;
        const replacementIndex = retry && S.chatMessages[S.chatMessages.length - 1]?.role === "assistant"
            ? S.chatMessages.length - 1 : -1;
        const history = replacementIndex >= 0 ? S.chatMessages.slice(0, replacementIndex) : S.chatMessages;
        const draft = replacementIndex >= 0 ? "" : userText;
        const body = I.buildChatBody(history, draft);
        const runtimeKey = getChatRuntimeKey();
        const stale = () => !I.workspaceMutationAllowed(ownerEpoch) || attemptToken !== S.sendAttemptToken || runtimeKey !== getChatRuntimeKey();
        cancelContextPreview();
        const revision = S.contextRevision;
        const budget = await refreshContextPreview(body, revision);
        if (stale()) return false;
        const key = contextBodyKey(body);
        const nearFull = budget && ["warning", "overflow"].includes(budget.status)
            && S.latestContextBodyKey === key;
        if (!nearFull || compaction.boundary(S.chatMessages) <= (S.chatCompactions.at(-1)?.end || 0)) return true;

        S.autoCompactionAttempted = true;
        const compacted = await compactConversation(draft);
        if (stale()) return false;
        if (!compacted) return false;

        const afterHistory = replacementIndex >= 0 ? S.chatMessages.slice(0, replacementIndex) : S.chatMessages;
        const afterBody = I.buildChatBody(afterHistory, draft);
        cancelContextPreview();
        const afterRevision = S.contextRevision;
        const measured = await refreshContextPreview(afterBody, afterRevision);
        if (stale()) return false;
        if (!measured) {
            const status = document.getElementById("chat-compaction-status");
            if (status) {
                status.textContent = "The summary was saved, but context could not be rechecked. Sending is paused; try again when the server is ready.";
                status.hidden = false;
            }
            return false;
        }
        if (measured.status === "overflow") {
            const status = document.getElementById("chat-compaction-status");
            if (status) {
                status.textContent = "The compacted context still exceeds the limit. Shorten the draft, lower Max Tokens, or increase context before sending.";
                status.hidden = false;
            }
            return false;
        }
        return true;
    }

    Object.assign(I, {
        getCompactionKey,
        getChatRuntimeKey,
        updateCompactionControls,
        renderCompactionMarker,
        undoCompaction,
        compactConversation,
        setChatToolsOpen,
        initChatTools,
        renderContextBudget,
        cancelContextPreview,
        contextBodyKey,
        isAutoCompactionEnabled,
        setAutoCompactionEnabled,
        ensureAutoCompactionControl,
        ensureEditStatusControl,
        scheduleContextPreview,
        refreshContextPreview,
        maybeCompactBeforeSend,
    });
})();
