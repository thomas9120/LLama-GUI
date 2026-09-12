// Chat package (8/8): init() plus the public window.LlamaGui.chatUi assembly. Loaded last.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const {
        CHAT_SETTINGS_COLLAPSED_STORAGE_KEY,
        CHAT_HISTORY_COLLAPSED_STORAGE_KEY,
        CHAT_WEB_SEARCH_STORAGE_KEY,
        CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY,
        CHAT_NUMERIC_INPUTS,
    } = I.consts;

    function init() {
        I.initChatTools();
        window.LlamaGui.chatTools.init(() => {
            I.scheduleContextPreview(true);
            I.requestWorkspaceCheckpoint({ reason: "datetime-preference" });
        });
        I.ensureAutoCompactionControl();
        I.ensureEditStatusControl();
        I.wireChatScrollControls();
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        const undoBtn = document.getElementById("btn-chat-undo");
        const regenBtn = document.getElementById("btn-chat-regenerate");
        const focusBtn = document.getElementById("btn-chat-focus");
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        const characterFile = document.getElementById("chat-character-file");
        document.getElementById("btn-chat-load-character")?.addEventListener("click", () => characterFile?.click());
        characterFile?.addEventListener("change", () => {
            const file = characterFile.files?.[0];
            characterFile.value = "";
            void I.importCharacterCard(file);
        });
        const webSearchToggle = document.getElementById("chat-web-search-toggle");
        const webSearchMaxResults = document.getElementById("chat-web-search-max-results");
        const thinkingEffort = document.getElementById("chat-thinking-effort");
        const openQuickLaunchBtn = document.getElementById("btn-chat-open-quick-launch");

        I.updateStatusBadge();

        if (webSearchToggle) {
            webSearchToggle.checked = I.getStoredItem(CHAT_WEB_SEARCH_STORAGE_KEY) === "true";
            webSearchToggle.addEventListener("change", () => {
                if (!I.workspaceMutationAllowed()) return;
                I.setChatPreference(CHAT_WEB_SEARCH_STORAGE_KEY, String(webSearchToggle.checked));
                I.scheduleContextPreview();
            });
        }

        if (webSearchMaxResults) {
            webSearchMaxResults.value = String(I.clampChatWebSearchMaxResults(
                I.getStoredItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY)
            ));
            webSearchMaxResults.addEventListener("change", () => {
                const value = I.clampChatWebSearchMaxResults(webSearchMaxResults.value);
                webSearchMaxResults.value = String(value);
                I.setChatPreference(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
            webSearchMaxResults.addEventListener("input", () => {
                const value = I.clampChatWebSearchMaxResults(webSearchMaxResults.value);
                I.setChatPreference(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
        }

        if (thinkingEffort) {
            thinkingEffort.title = "Auto lets the loaded model choose. Off asks for a direct answer; levels request more or less reasoning when supported.";
            I.setChatThinkingEffort(thinkingEffort.value);
            thinkingEffort.addEventListener("change", () => {
                if (!I.workspaceMutationAllowed()) return;
                I.setChatThinkingEffort(thinkingEffort.value);
                I.refreshSidebarUI();
                I.saveCurrentConversation();
                I.scheduleContextPreview();
            });
        }

        chatInput.addEventListener("input", () => {
            I.scheduleContextPreview();
            I.requestWorkspaceCheckpoint({ reason: "draft" });
            chatInput.style.height = "auto";
            chatInput.style.height = Math.min(chatInput.scrollHeight, 220) + "px";
        });

        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                I.sendMessage(chatInput.value);
            }
        });

        sendBtn.addEventListener("click", () => I.sendMessage(chatInput.value));
        stopBtn.addEventListener("click", I.stopStream);
        document.getElementById("btn-chat-compact")?.addEventListener("click", () => {
            if (S.compactionController) S.compactionController.abort();
            else void I.compactConversation();
        });
        undoBtn.addEventListener("click", I.undoMessage);
        regenBtn.addEventListener("click", I.regenerateResponse);
        if (focusBtn) {
            focusBtn.addEventListener("click", () => I.setChatFocusMode(!S.chatFocusMode));
            I.updateChatFocusButton();
        }
        if (openQuickLaunchBtn) {
            openQuickLaunchBtn.addEventListener("click", () => S.switchTab("quick-launch"));
        }

        sysPrompt.addEventListener("input", () => {
            if (!I.workspaceMutationAllowed()) return;
            I.scheduleContextPreview();
            sysCharCount.textContent = sysPrompt.value.length + " chars";
            I.requestWorkspaceCheckpoint({ reason: "system-prompt" });
        });
        sysCharCount.textContent = "0 chars";

        I.initChatPanel("chat-sidebar", "btn-open-sidebar", "btn-collapse-sidebar", CHAT_SETTINGS_COLLAPSED_STORAGE_KEY);
        I.initChatPanel("chat-history-panel", "btn-open-history", "btn-collapse-history", CHAT_HISTORY_COLLAPSED_STORAGE_KEY);

        const newChatBtn = document.getElementById("btn-chat-new");
        if (newChatBtn) {
            newChatBtn.addEventListener("click", I.startNewChat);
        }

        const deleteAllBtn = document.getElementById("btn-delete-all-history");
        if (deleteAllBtn) {
            deleteAllBtn.addEventListener("click", async () => {
                if (I.getStoredConversations().length === 0) return;
                const confirmed = await I.requestConfirmation("Delete All Conversations", "Delete all saved conversations? This cannot be undone.", "Delete All");
                if (confirmed) {
                    await I.deleteAllConversations();
                }
            });
        }

        const historySearch = document.getElementById("chat-history-search");
        if (historySearch) {
            S.chatHistoryFilter = historySearch.value || "";
            historySearch.addEventListener("input", () => {
                S.chatHistoryFilter = historySearch.value || "";
                I.renderHistoryList();
            });
        }
        I.renderHistoryList();

        for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
            const slider = document.getElementById(sliderId);
            const display = document.getElementById(sliderId.replace("slider", "val"));
            if (!slider || !display) continue;

            slider.addEventListener("input", () => {
                if (!I.workspaceMutationAllowed()) return;
                const raw = parseFloat(slider.value);
                display.textContent = raw.toFixed(meta.decimals);
                const val = meta.flag === "top_k" ? parseInt(slider.value, 10) : parseFloat(slider.value);
                I.setChatSamplerValue(meta.flag, val);
            });
        }

        for (const [inputId, meta] of Object.entries(CHAT_NUMERIC_INPUTS)) {
            const input = document.getElementById(inputId);
            if (!input) continue;
            input.addEventListener("change", () => {
                if (!I.workspaceMutationAllowed()) return;
                const raw = String(input.value || "").trim();
                const parsed = Number(raw);
                if (raw && Number.isFinite(parsed) && (!meta.integer || Number.isInteger(parsed))) {
                    I.setChatSamplerValue(meta.flag, parsed);
                }
                I.refreshSidebarUI();
            });
            input.addEventListener("input", () => {
                if (!I.workspaceMutationAllowed()) return;
                const raw = String(input.value || "").trim();
                const parsed = Number(raw);
                if (raw && Number.isFinite(parsed) && (!meta.integer || Number.isInteger(parsed))) {
                    I.setChatSamplerValue(meta.flag, parsed);
                }
                I.scheduleContextPreview();
            });
        }

        const clearBtn = document.getElementById("btn-chat-clear");
        if (clearBtn) {
            clearBtn.addEventListener("click", async () => {
                const confirmed = await I.requestConfirmation("Clear Current Chat", "Clear this chat, including its saved conversation and system prompt? This cannot be undone.", "Clear Chat");
                if (confirmed) await I.clearChat();
            });
        }

        I.refreshSidebarUI();
    }

    Object.assign(I, {
        init,
    });

    window.LlamaGui.chatUi = {
        configure: I.configure,
        configureWorkspace: I.configureWorkspace,
        getTransferState: I.getTransferState,
        suspendTransfer: I.suspendTransfer,
        resumeTransfer: I.resumeTransfer,
        setOwnership: I.setOwnership,
        setHostAvailable: I.setHostAvailable,
        captureSnapshot: I.captureSnapshot,
        validateSnapshot: I.validateSnapshot,
        restoreSnapshot: I.restoreSnapshot,
        resetWorkspace: I.resetWorkspace,
        saveForTransfer: I.saveForTransfer,
        captureLayout: I.captureLayout,
        restoreLayout: I.restoreLayout,
        getChatSamplerValues: I.getChatSamplerValues,
        getChatSamplerFlagIds: I.getChatSamplerFlagIds,
        setChatSamplerValue: I.setChatSamplerValue,
        init,
        onTabChanged: I.onTabChanged,
        refreshSidebarUI: I.refreshSidebarUI,
        updateStatusBadge: I.updateStatusBadge,
        refreshTemplateCaps: I.refreshTemplateCaps,
        abortActiveStream: I.abortActiveStream,
        addModelTransitionDivider: I.addModelTransitionDivider,
    };

    // Test-only hooks. These are live mutators that bypass the confirm flows
    // wired up in init(), so they stay off the shipped namespace unless the
    // harness opts in before this file is evaluated.
    if (window.__LLAMA_GUI_TEST_HOOKS__) {
        Object.assign(window.LlamaGui.chatUi, {
            _testSendMessage: I.sendMessage,
            _testLoadConversation: I.loadConversation,
            _testClearChat: I.clearChat,
            _testStartNewChat: I.startNewChat,
            _testImportCharacterCard: I.importCharacterCard,
            _testDeleteAllConversations: I.deleteAllConversations,
            _testRegenerateResponse: I.regenerateResponse,
            _testCompactConversation: I.compactConversation,
            _testUndoCompaction: I.undoCompaction,
            _testUndoMessage: I.undoMessage,
            _testEditUserMessage: I.editUserMessage,
            _testCancelEdit: I.cancelEdit,
            _testRenameConversation: I.renameConversation,
            _testExportConversation: I.exportConversation,
            _testDeleteConversation: I.deleteConversation,
            _testSetAutoCompaction: I.setAutoCompactionEnabled,
            _testGetState: () => ({
                chatMessages: S.chatMessages.slice(),
                currentConversationId: S.currentConversationId,
                chatStreaming: S.chatStreaming,
                chatCompactions: S.chatCompactions.slice(),
                pendingEdit: S.pendingEdit ? { ...S.pendingEdit, tail: S.pendingEdit.tail.slice() } : null,
            }),
        });
    }
})();
