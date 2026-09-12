// Chat package (7/8): conversation persistence, history list rendering, clearChat, character card import.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const { CHAT_CONVERSATIONS_STORAGE_KEY, CHAT_MAX_STORED_CONVERSATIONS } = I.consts;
    const compaction = window.LlamaGui.chatCompaction;

    function getStoredConversations() {
        try {
            const parsed = JSON.parse(I.getStoredItem(CHAT_CONVERSATIONS_STORAGE_KEY) || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.debug("Failed to read stored conversations", e);
            return [];
        }
    }

    function renderHistoryRetention(count = getStoredConversations().length) {
        const label = document.getElementById("chat-history-retention");
        if (!label) return;
        label.textContent = S.historyRetentionNotice
            ? `History keeps ${CHAT_MAX_STORED_CONVERSATIONS} conversations; older entries have been removed.`
            : `History retention: ${count} of ${CHAT_MAX_STORED_CONVERSATIONS} conversations saved.`;
    }

    function saveConversationsToStorage(list) {
        if (!I.workspacePersistentWriteAllowed()) return false;
        const all = Array.isArray(list) ? list : [];
        const pruned = all.slice(0, CHAT_MAX_STORED_CONVERSATIONS);
        const saved = I.setStoredItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(pruned));
        S.historyRetentionNotice = saved && all.length > CHAT_MAX_STORED_CONVERSATIONS;
        if (!saved && typeof window.showToast === "function") {
            window.showToast("Conversation history could not be saved. Your active chat remains available for this session.", "warning");
        }
        renderHistoryRetention(pruned.length);
        return saved;
    }

    function saveCurrentConversation(options = {}) {
        if (!I.workspacePersistentWriteAllowed()) return false;
        if (S.chatMessages.length === 0 && !S.currentConversationId) return true;
        const sysPrompt = document.getElementById("chat-system-prompt");
        const conversations = getStoredConversations();
        const existing = S.currentConversationId
            ? conversations.find(c => c.id === S.currentConversationId)
            : null;

        if (existing) {
            existing.messages = S.chatMessages.slice();
            existing.compactions = S.chatCompactions.slice();
            existing.systemPrompt = sysPrompt ? sysPrompt.value : "";
            existing.thinkingEffort = I.getChatThinkingEffort();
            existing.timestamp = Date.now();
            if (!existing.title) existing.title = generateConversationTitle(S.chatMessages);
        } else {
            const newId = S.currentConversationId || I.createConversationId();
            const convo = {
                id: newId,
                title: S.workspaceConversationTitle || generateConversationTitle(S.chatMessages),
                titleCustom: S.workspaceConversationTitleCustom,
                messages: S.chatMessages.slice(),
                compactions: S.chatCompactions.slice(),
                systemPrompt: sysPrompt ? sysPrompt.value : "",
                thinkingEffort: I.getChatThinkingEffort(),
                timestamp: Date.now()
            };
            conversations.unshift(convo);
        }

        const saved = saveConversationsToStorage(conversations);
        if (saved && !S.currentConversationId) S.currentConversationId = conversations[0].id;
        renderHistoryList();
        if (saved && !options.skipCheckpoint) I.requestWorkspaceCheckpoint({ reason: "conversation-save" });
        if (saved) I.notifyWorkspaceChange();
        return saved;
    }

    function generateConversationTitle(messages) {
        const first = messages.find(m => m.role === "user");
        if (!first) return "Untitled";
        const text = first.content.trim().replace(/\n/g, " ");
        return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }

    async function loadConversation(id) {
        if (!I.workspaceMutationAllowed()) return false;
        const ownerEpoch = S.workspaceEpoch;
        reportCharacterImport();
        I.setChatToolsOpen(false);
        // Must await: abort() rejects the pending read on a later microtask, so a
        // bare I.stopStream() lets the AbortError handler run after the reassignments
        // below and finalize the old reply into the conversation we just loaded.
        if (S.chatStreaming || S.compactionController || S.sendPreflightPromise) await I.abortActiveStream();
        I.discardPendingEdit();

        // Read storage only after the abort has settled: finalizing the aborted
        // reply writes to storage, so a snapshot taken earlier would be stale and
        // reloading the streaming conversation would drop the in-flight turn.
        if (!I.workspaceMutationAllowed(ownerEpoch)) return false;
        const conversations = getStoredConversations();
        const convo = conversations.find(c => c.id === id);
        if (!convo || !I.workspaceMutationAllowed(ownerEpoch)) return false;
        if (!I.invalidateWorkspace()) return false;

        S.currentConversationId = convo.id;
        S.workspaceConversationTitle = convo.title || null;
        S.workspaceConversationTitleCustom = Boolean(convo.titleCustom);
        S.streamingCheckpoint = null;
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        S.chatMessages = convo.messages.slice();
        S.chatCompactions = (Array.isArray(convo.compactions) ? convo.compactions : [])
            .filter(record => compaction.valid(record, S.chatMessages));

        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) {
            sysPrompt.value = convo.systemPrompt || "";
            if (sysCharCount) sysCharCount.textContent = (convo.systemPrompt || "").length + " chars";
        }
        I.setChatThinkingEffort(convo.thinkingEffort);

        I.renderConversationMessages();

        renderHistoryList();
        if (S.snapshotStatsBaseline) S.snapshotStatsBaseline();
        I.requestWorkspaceCheckpoint({ reason: "conversation-load" });
        I.notifyWorkspaceChange();
        return true;
    }

    function renameConversation(id, title) {
        if (!I.workspaceMutationAllowed()) return false;
        const normalized = String(title || "").trim().replace(/\s+/g, " ");
        if (!normalized) return false;
        const conversations = getStoredConversations();
        const convo = conversations.find(item => item.id === id);
        if (!convo) return false;
        const previous = convo.title;
        convo.title = normalized.slice(0, 120);
        convo.titleCustom = true;
        if (!saveConversationsToStorage(conversations)) {
            convo.title = previous;
            return false;
        }
        if (id === S.currentConversationId) {
            S.workspaceConversationTitle = convo.title;
            S.workspaceConversationTitleCustom = true;
        }
        renderHistoryList();
        I.requestWorkspaceCheckpoint({ reason: "rename" });
        return true;
    }

    function requestConversationRename(id) {
        if (!I.workspaceMutationAllowed()) return false;
        const convo = getStoredConversations().find(item => item.id === id);
        if (!convo) return false;
        const prompt = typeof window.prompt === "function" ? window.prompt("Conversation name", convo.title || "") : "";
        if (prompt !== null && prompt !== undefined) renameConversation(id, prompt);
        return true;
    }

    function exportConversation(id, format = "json") {
        const convo = getStoredConversations().find(item => item.id === id);
        if (!convo) return "";
        const isText = format === "text";
        const data = isText
            ? convo.messages.map(message => `${String(message.role || "").toUpperCase()}:\n${message.content || ""}`).join("\n\n")
            : JSON.stringify(convo, null, 2);
        if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || !document.createElement) return data;
        const blob = new Blob([data], { type: isText ? "text/plain" : "application/json" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = `${(convo.title || "conversation").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "conversation"}.${isText ? "txt" : "json"}`;
        anchor.click();
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(href);
        return data;
    }

    function resetActiveChatState() {
        S.currentConversationId = null;
        S.workspaceConversationTitle = null;
        S.workspaceConversationTitleCustom = false;
        S.chatMessages = [];
        S.chatCompactions = [];
        S.streamingCheckpoint = null;
        I.discardPendingEdit();
        const container = document.getElementById("chat-messages");
        container?.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        I.renderCompactionMarker();
        I.updateCompactionControls();
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        I.setChatThinkingEffort("auto");
        I.scheduleContextPreview(true);
    }

    async function deleteConversation(id) {
        if (!I.workspaceMutationAllowed()) return false;
        const ownerEpoch = S.workspaceEpoch;
        if (S.currentConversationId === id && (S.chatStreaming || S.compactionController || S.sendPreflightPromise)) await I.abortActiveStream();
        if (!I.workspaceMutationAllowed(ownerEpoch)) return false;
        const conversations = getStoredConversations();
        const deleted = conversations.find(c => c.id === id);
        if (!deleted) return false;
        const filtered = conversations.filter(c => c.id !== id);
        if (!I.invalidateWorkspace()) return false;
        if (!saveConversationsToStorage(filtered)) return false;
        if (S.currentConversationId === id) resetActiveChatState();

        renderHistoryList();
        I.notifyWorkspaceChange();
        return true;
    }

    async function deleteAllConversations() {
        if (!I.workspaceMutationAllowed()) return false;
        const ownerEpoch = S.workspaceEpoch;
        if (S.chatStreaming || S.compactionController || S.sendPreflightPromise) await I.abortActiveStream();
        if (!I.workspaceMutationAllowed(ownerEpoch) || !I.invalidateWorkspace()) return false;
        if (!saveConversationsToStorage([])) return false;
        resetActiveChatState();
        renderHistoryList();
        I.notifyWorkspaceChange();
        return true;
    }

    async function startNewChat() {
        if (!I.workspaceMutationAllowed()) return false;
        const ownerEpoch = S.workspaceEpoch;
        reportCharacterImport();
        I.setChatToolsOpen(false);
        // Stop before saving: an in-flight stream would otherwise keep appending
        // tokens into the fresh chat and leave the composer disabled.
        if (S.chatStreaming || S.compactionController || S.sendPreflightPromise) await I.abortActiveStream();
        if (!I.workspaceMutationAllowed(ownerEpoch)) return false;
        I.discardPendingEdit();
        if (!saveCurrentConversation()) return false;
        if (!I.invalidateWorkspace()) return false;
        S.currentConversationId = null;
        S.workspaceConversationTitle = null;
        S.workspaceConversationTitleCustom = false;
        S.chatMessages = [];
        S.chatCompactions = [];
        S.streamingCheckpoint = null;
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        I.renderCompactionMarker();
        I.updateCompactionControls();
        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        I.setChatThinkingEffort("auto");
        I.scheduleContextPreview(true);
        renderHistoryList();
        if (S.snapshotStatsBaseline) S.snapshotStatsBaseline();
        I.notifyWorkspaceChange();
        return true;
    }

    function renderHistoryList() {
        const list = document.getElementById("chat-history-list");
        if (!list) return;

        const conversations = getStoredConversations();
        list.innerHTML = "";
        renderHistoryRetention(conversations.length);
        const query = S.chatHistoryFilter.trim().toLocaleLowerCase();
        const visibleConversations = query
            ? conversations.filter(convo => `${convo.title || ""} ${JSON.stringify(convo.messages || [])}`.toLocaleLowerCase().includes(query))
            : conversations;

        if (visibleConversations.length === 0) {
            const empty = document.createElement("div");
            empty.className = "chat-history-empty";
            empty.textContent = query ? "No conversations match your search" : "No saved conversations";
            list.appendChild(empty);
            return;
        }

        for (const convo of visibleConversations) {
            const item = document.createElement("div");
            item.className = "chat-history-item" + (convo.id === S.currentConversationId ? " active" : "");

            const header = document.createElement("div");
            header.className = "chat-history-item-header";

            const title = document.createElement("div");
            title.className = "chat-history-item-title";
            title.textContent = convo.title;

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "btn btn-xs chat-history-item-delete";
            deleteBtn.textContent = "Delete";
            deleteBtn.title = "Delete conversation";
            deleteBtn.setAttribute("aria-label", "Delete conversation");
            deleteBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const confirmed = await I.requestConfirmation("Delete Conversation", `Delete "${convo.title || "Untitled"}"? This cannot be undone.`, "Delete");
                if (confirmed) return deleteConversation(convo.id);
            });

            const renameBtn = document.createElement("button");
            renameBtn.className = "btn btn-xs chat-history-item-rename";
            renameBtn.textContent = "Rename";
            renameBtn.title = "Rename conversation";
            renameBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                requestConversationRename(convo.id);
            });

            const exportBtn = document.createElement("button");
            exportBtn.className = "btn btn-xs chat-history-item-export";
            exportBtn.textContent = "Export";
            exportBtn.title = "Export conversation as JSON";
            exportBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                exportConversation(convo.id);
            });

            header.appendChild(title);

            const actions = document.createElement("div");
            actions.className = "chat-history-item-actions";
            actions.appendChild(renameBtn);
            actions.appendChild(exportBtn);
            actions.appendChild(deleteBtn);

            const preview = document.createElement("div");
            preview.className = "chat-history-item-preview";
            const lastMsg = convo.messages[convo.messages.length - 1];
            preview.textContent = I.getMessagePreviewText(lastMsg);

            const time = document.createElement("div");
            time.className = "chat-history-item-time";
            time.textContent = formatHistoryTime(convo.timestamp);

            item.appendChild(header);
            item.appendChild(preview);
            item.appendChild(time);
            item.appendChild(actions);

            item.addEventListener("click", () => loadConversation(convo.id));
            list.appendChild(item);
        }
    }

    function formatHistoryTime(ts) {
        const d = new Date(ts);
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return "Just now";
        if (diffMin < 60) return diffMin + "m ago";
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return diffHr + "h ago";
        return d.toLocaleDateString();
    }

    async function clearChat() {
        if (!I.workspaceMutationAllowed()) return false;
        const ownerEpoch = S.workspaceEpoch;
        I.setChatToolsOpen(false);
        if (S.chatStreaming || S.compactionController || S.sendPreflightPromise) await I.abortActiveStream();
        if (!I.workspaceMutationAllowed(ownerEpoch)) return false;
        I.discardPendingEdit();
        if (S.currentConversationId) {
            const deleted = await deleteConversation(S.currentConversationId);
            if (!deleted) return;
            if (S.snapshotStatsBaseline) S.snapshotStatsBaseline();
            return true;
        }
        if (!I.invalidateWorkspace()) return false;
        S.chatMessages = [];
        S.chatCompactions = [];
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        I.renderCompactionMarker();
        I.updateCompactionControls();
        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        I.setChatThinkingEffort("auto");
        I.scheduleContextPreview(true);
        if (S.snapshotStatsBaseline) S.snapshotStatsBaseline();
        I.notifyWorkspaceChange();
        return true;
    }

    function reportCharacterImport(message = "") {
        const status = document.getElementById("chat-character-status");
        if (status) { status.textContent = message; status.hidden = !message; }
    }

    async function importCharacterCard(file) {
        if (!I.workspaceMutationAllowed() || !file || S.characterImportPending || S.chatStreaming || S.compactionController || S.sendPreflightPromise) return false;
        const ownerEpoch = S.workspaceEpoch;
        S.characterImportPending = true;
        I.updateChatAvailability(I.isServerRunning());
        reportCharacterImport("Reading character card…");
        const originalMessages = S.chatMessages;
        const originalLength = S.chatMessages.length;
        const originalPrompt = document.getElementById("chat-system-prompt").value;
        try {
            const card = await window.LlamaGui.characterCards.readFile(file);
            if (S.chatMessages !== originalMessages || S.chatMessages.length !== originalLength
                || document.getElementById("chat-system-prompt").value !== originalPrompt
                || !I.workspaceMutationAllowed(ownerEpoch) || S.chatStreaming || S.compactionController || S.sendPreflightPromise) {
                throw new Error("Chat changed while reading the card. Please load it again.");
            }
            if (!saveCurrentConversation()) throw new Error("Could not save the current conversation. The character was not loaded.");
            const conversation = {
                id: I.createConversationId(), title: card.name.slice(0, 120),
                messages: card.greeting.trim() ? [{ role: "assistant", content: card.greeting }] : [],
                compactions: [], systemPrompt: card.systemPrompt, thinkingEffort: "auto", timestamp: Date.now(),
            };
            const conversations = getStoredConversations();
            conversations.unshift(conversation);
            if (!I.invalidateWorkspace()) throw new Error("The chat changed while importing the character. Please try again.");
            if (!saveConversationsToStorage(conversations)) throw new Error("Could not save the character chat. The current conversation is still open.");
            if (!I.workspaceMutationAllowed(ownerEpoch) || !(await loadConversation(conversation.id))) {
                throw new Error("The chat changed while loading the character. Please try again.");
            }
            reportCharacterImport([`Started a chat with ${card.name}.`, ...card.notices].join(" "));
        } catch (error) {
            console.debug("Character card import did not complete", error);
            reportCharacterImport(error.message || "Could not read the character card. Try another JSON or PNG file.");
        } finally {
            S.characterImportPending = false;
            I.updateChatAvailability(I.isServerRunning());
            I.notifyWorkspaceChange();
        }
        return true;
    }

    Object.assign(I, {
        getStoredConversations,
        renderHistoryRetention,
        saveConversationsToStorage,
        saveCurrentConversation,
        generateConversationTitle,
        loadConversation,
        renameConversation,
        requestConversationRename,
        exportConversation,
        resetActiveChatState,
        deleteConversation,
        deleteAllConversations,
        startNewChat,
        renderHistoryList,
        formatHistoryTime,
        clearChat,
        reportCharacterImport,
        importCharacterCard,
    });
})();
