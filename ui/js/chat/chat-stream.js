// Chat package (6/8): send/stream pipeline, scroll handling, edit flow, assistant rendering, undo and regenerate.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const {
        renderChatMessage,
        setChatWebStatus,
        renderChatSources,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
        appendChatReasoningStreamToken,
        splitReasoningFromContent,
        setChatResponseMetadata,
        isChatNearBottom: renderingIsChatNearBottom,
        scrollChatToLatest: renderingScrollChatToLatest,
    } = window.LlamaGui.chatRendering;
    const compaction = window.LlamaGui.chatCompaction;

    function sendMessage(userText, retry = false) {
        if (!I.workspaceMutationAllowed() || S.chatStreaming || S.compactionController || S.sendPreflightPromise || !userText.trim()) return Promise.resolve(false);
        S.autoCompactionAttempted = false;
        const attemptToken = ++S.sendAttemptToken;
        const ownerEpoch = S.workspaceEpoch;
        const pending = runMessage(userText, retry, attemptToken, ownerEpoch);
        S.sendPreflightPromise = pending;
        S.chatStreamPromise = pending;
        I.updateChatAvailability(I.isServerRunning());
        const clearPending = () => {
            if (S.chatStreamPromise === pending) S.chatStreamPromise = null;
            if (S.sendPreflightPromise === pending) {
                S.sendPreflightPromise = null;
                I.updateChatAvailability(I.isServerRunning());
            }
        };
        pending.then(clearPending, clearPending);
        return pending;
    }

    function getChatMessagesContainer() {
        return document.getElementById("chat-messages");
    }

    function isChatNearBottom(container) {
        return !container || renderingIsChatNearBottom(container);
    }

    function updateChatJumpButton(show) {
        const button = document.getElementById("btn-chat-jump-latest");
        if (!button) return;
        button.hidden = !show;
        button.setAttribute("aria-hidden", String(!show));
        button.textContent = "Jump to latest";
    }

    function captureChatScrollState() {
        const container = getChatMessagesContainer();
        const follow = isChatNearBottom(container);
        S.chatScrollState = { follow, top: container ? container.scrollTop : 0 };
        updateChatJumpButton(!follow);
        return S.chatScrollState;
    }

    function followChatOutput() {
        const container = getChatMessagesContainer();
        if (!container || !S.chatScrollState?.follow) {
            if (container && S.chatScrollState) container.scrollTop = S.chatScrollState.top;
            updateChatJumpButton(Boolean(S.chatScrollState && !S.chatScrollState.follow));
            return;
        }
        renderingScrollChatToLatest(container);
        updateChatJumpButton(false);
    }

    function restoreChatScrollPosition() {
        const container = getChatMessagesContainer();
        if (container && S.chatScrollState && !S.chatScrollState.follow) container.scrollTop = S.chatScrollState.top;
    }

    function jumpToLatest() {
        const container = getChatMessagesContainer();
        if (!container) return;
        S.chatScrollState = { follow: true, top: container.scrollHeight };
        renderingScrollChatToLatest(container);
        updateChatJumpButton(false);
    }

    function wireChatScrollControls() {
        const container = getChatMessagesContainer();
        const button = document.getElementById("btn-chat-jump-latest");
        if (button && !button.dataset.chatJumpWired) {
            button.dataset.chatJumpWired = "1";
            button.addEventListener("click", jumpToLatest);
        }
        if (container && !container.dataset.chatScrollWired) {
            container.dataset.chatScrollWired = "1";
            container.addEventListener("scroll", () => {
                const near = isChatNearBottom(container);
                if (S.chatScrollState) {
                    S.chatScrollState.follow = near;
                    if (!near) S.chatScrollState.top = container.scrollTop;
                }
                updateChatJumpButton(!near);
            });
        }
    }

    function updateResponseMetadata(metadata, event, finishReason) {
        if (event?.usage && typeof event.usage === "object") metadata.usage = { ...event.usage };
        if (event?.timings && typeof event.timings === "object") metadata.timings = { ...event.timings };
        if (finishReason) metadata.stop_reason = String(finishReason);
    }

    async function editUserMessage(index) {
        if (!I.workspaceMutationAllowed() || S.chatStreaming || S.compactionController || !S.chatMessages[index] || S.chatMessages[index].role !== "user") return false;
        const ownerEpoch = S.workspaceEpoch;
        const stored = I.getStoredConversations();
        const active = S.currentConversationId && stored.find(item => item.id === S.currentConversationId);
        const backupTitle = `${active?.title || I.generateConversationTitle(S.chatMessages)} — before edit`;
        const confirmed = await I.requestConfirmation("Edit and resend", `A selectable history copy named “${backupTitle}” will preserve the current conversation and later turns. The active conversation will be truncated only when you resend. Continue?`, "Edit message");
        if (!confirmed || !I.workspaceMutationAllowed(ownerEpoch)) return false;
        const input = document.getElementById("chat-input");
        if (!input) return false;
        S.pendingEdit = {
            index,
            originalText: S.chatMessages[index].content,
            tail: S.chatMessages.slice(index + 1),
        };
        input.value = S.chatMessages[index].content || "";
        input.focus?.();
        const status = document.getElementById("chat-edit-status");
        if (status) {
            if (status.children[0]) status.children[0].textContent = `A history copy named “${backupTitle}” will preserve later turns when you resend.`;
            status.hidden = false;
        }
        return true;
    }

    function cancelEdit() {
        if (!S.pendingEdit) return;
        const input = document.getElementById("chat-input");
        if (input) input.value = S.pendingEdit.originalText || "";
        discardPendingEdit();
        const status = document.getElementById("chat-edit-status");
        if (status) { if (status.children[0]) status.children[0].textContent = ""; status.hidden = true; }
    }

    function discardPendingEdit() {
        S.pendingEdit = null;
        const status = document.getElementById("chat-edit-status");
        if (status) { if (status.children[0]) status.children[0].textContent = ""; status.hidden = true; }
    }

    function createConversationId() {
        return (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
            ? crypto.randomUUID()
            : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0;
                return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
              });
    }

    function persistEditBranch(edit) {
        if (!I.workspacePersistentWriteAllowed() || !edit) return false;
        const conversations = I.getStoredConversations();
        const existing = S.currentConversationId && conversations.find(item => item.id === S.currentConversationId);
        if (!existing) return false;
        let backup;
        try {
            backup = JSON.parse(JSON.stringify(existing));
        } catch (error) {
            console.warn("Could not prepare the before-edit history copy", error);
            return false;
        }
        const baseTitle = existing.title || I.generateConversationTitle(existing.messages || S.chatMessages);
        backup.id = createConversationId();
        backup.title = `${baseTitle} — before edit`;
        backup.titleCustom = true;
        backup.timestamp = Date.now();
        backup.backupOf = existing.id;
        return I.saveConversationsToStorage([backup, ...conversations]);
    }

    function finalizeAssistantResponse(content, reasoning, sources, status, error, replacementIndex, metadata = {}, toolMessages = [], expectedEpoch = S.workspaceEpoch) {
        if (!I.workspaceMutationAllowed(expectedEpoch)) return false;
        let finalContent = content;
        let finalReasoning = reasoning;
        if (!finalReasoning && I.shouldExtractEmbeddedReasoning()) {
            const split = splitReasoningFromContent(finalContent);
            if (split.reasoning) {
                finalContent = split.content;
                finalReasoning = split.reasoning;
            }
        }
        const result = { content: finalContent, reasoning: finalReasoning, sources, status, error, metadata };
        if (toolMessages.length) result.toolMessages = toolMessages;
        const previous = replacementIndex >= 0 ? S.chatMessages[replacementIndex] : null;
        if (previous) {
            const versions = Array.isArray(previous.versions) ? previous.versions.slice() : [{
                content: previous.content, reasoning: previous.reasoning || "",
                sources: previous.sources || [], status: previous.status || "complete", error: previous.error || "",
                metadata: previous.metadata || {},
                ...(previous.toolMessages ? { toolMessages: previous.toolMessages } : {}),
            }];
            versions.push(result);
            // An unsuccessful attempt is still recoverable, but never replaces
            // the answer the user was reading. Only completed output is selected.
            const selected = status === "complete" || status === "length"
                ? versions.length - 1 : (previous.versionIndex || 0);
            S.chatMessages[replacementIndex] = {
                role: "assistant", ...versions[selected], versions, versionIndex: selected,
            };
        } else {
            S.chatMessages.push({ role: "assistant", ...result });
        }
        I.saveCurrentConversation();
        renderConversationMessages(replacementIndex >= 0 ? replacementIndex : S.chatMessages.length - 1);
        S.streamingCheckpoint = null;
        I.requestWorkspaceCheckpoint({ reason: "response-finalized" });
        I.notifyWorkspaceChange();
        return true;
    }

    function renderConversationMessages(startIndex = 0) {
        const container = document.getElementById("chat-messages");
        const previousElements = Array.from(container.querySelectorAll(".chat-message"));
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = S.chatMessages.length ? "none" : "";
        S.chatMessages.forEach((msg, index) => {
            if (index < startIndex) {
                // Earlier assistant actions no longer target the latest turn,
                // while user edit actions remain available for every turn.
                if (msg.role === "assistant") {
                    previousElements[index]?.querySelectorAll(".chat-response-action").forEach(el => el.remove());
                }
                return;
            }
            const bubble = renderChatMessage(msg.role, msg.content, { reasoning: msg.reasoning });
            const previousElement = previousElements[index];
            if (previousElement) {
                container.insertBefore(bubble.closest(".chat-message"), previousElement);
                previousElement.remove();
            }
            if (msg.role !== "assistant") {
                const footer = document.createElement("div");
                footer.className = "chat-response-footer chat-user-footer";
                const editButton = document.createElement("button");
                editButton.type = "button";
                editButton.className = "btn btn-xs chat-response-action";
                editButton.textContent = "Edit and resend";
                editButton.addEventListener("click", () => { void editUserMessage(index); });
                footer.appendChild(editButton);
                bubble.closest(".chat-message-content")?.appendChild(footer);
                return;
            }
            renderChatSources(bubble, msg.sources);
            window.LlamaGui.chatTools.renderResults(bubble, msg.toolMessages);
            setChatResponseMetadata(bubble, msg.metadata || {});
            if (!msg.content) bubble.classList.add("hidden");
            const footer = document.createElement("div");
            footer.className = "chat-response-footer";
            const label = document.createElement("span");
            label.className = "chat-response-status";
            label.textContent = msg.status === "failed" ? `Incomplete — ${msg.error || "Request failed"}`
                : msg.status === "stopped" ? "Stopped — response may be incomplete"
                : msg.status === "length" ? "Output limit reached" : "";
            footer.appendChild(label);
            const latest = index === S.chatMessages.length - 1;
            const addAction = (text, action, requiresServer = false) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "btn btn-xs chat-response-action";
                button.textContent = text;
                button.dataset.requiresServer = String(requiresServer);
                button.addEventListener("click", () => {
                    if (I.workspaceMutationAllowed() && !S.chatStreaming && !S.compactionController && S.chatMessages[index] === msg) return action();
                });
                footer.appendChild(button);
            };
            if (Array.isArray(msg.versions) && msg.versions.length > 1) {
                const selected = msg.versionIndex || 0;
                const versionLabel = document.createElement("span");
                versionLabel.textContent = `Answer ${selected + 1} of ${msg.versions.length}`;
                footer.appendChild(versionLabel);
                const lastAttempt = msg.versions[msg.versions.length - 1];
                if (selected < msg.versions.length - 1 && ["failed", "stopped"].includes(lastAttempt.status)) {
                    label.textContent += `${label.textContent ? ". " : ""}Latest attempt ${lastAttempt.status}; previous answer kept.`;
                }
                // Choosing a different answer after later turns would rewrite
                // their context. Branch/edit support is a separate change.
                const selectVersion = (value) => {
                    if (!I.workspaceMutationAllowed()) return false;
                    const previous = S.chatMessages[index];
                    S.chatMessages[index] = { role: "assistant", ...msg.versions[value], versions: msg.versions, versionIndex: value };
                    if (!I.saveCurrentConversation()) {
                        S.chatMessages[index] = previous;
                        return false;
                    }
                    renderConversationMessages(index);
                    I.requestWorkspaceCheckpoint({ reason: "select-version" });
                    return true;
                };
                if (latest && selected > 0) addAction("Previous answer", () => selectVersion(selected - 1));
                if (latest && selected < msg.versions.length - 1) addAction("Next answer", () => selectVersion(selected + 1));
            }
            const lastAttempt = Array.isArray(msg.versions) ? msg.versions[msg.versions.length - 1] : msg;
            if (latest && [msg.status, lastAttempt.status].some(value => ["failed", "stopped", "length"].includes(value))) {
                addAction("Retry", regenerateResponse, true);
            }
            bubble.closest(".chat-message-content").appendChild(footer);
        });
        previousElements.slice(S.chatMessages.length).forEach(el => el.remove());
        I.renderCompactionMarker();
        I.updateChatAvailability(I.isServerRunning());
        I.scheduleContextPreview();
    }

    async function runMessage(userText, retry = false, attemptToken = S.sendAttemptToken, ownerEpoch = S.workspaceEpoch) {
        if (!I.workspaceMutationAllowed(ownerEpoch) || S.chatStreaming || S.compactionController || !userText.trim()) return false;
        if (!I.isServerRunning()) {
            I.updateStatusBadge();
            return;
        }

        const trimmedText = userText.trim();
        if (!await I.maybeCompactBeforeSend(trimmedText, attemptToken, retry, ownerEpoch)
            || !I.workspaceMutationAllowed(ownerEpoch) || attemptToken !== S.sendAttemptToken) return false;
        const editing = S.pendingEdit && !retry ? S.pendingEdit : null;
        if (editing && (editing.index >= S.chatMessages.length || S.chatMessages[editing.index]?.role !== "user")) {
            cancelEdit();
            return;
        }
        captureChatScrollState();

        I.cancelContextPreview();
        const replacementIndex = retry && S.chatMessages[S.chatMessages.length - 1]?.role === "assistant"
            ? S.chatMessages.length - 1 : -1;
        if (editing) {
            if (!I.invalidateWorkspace()) return false;
            if (!persistEditBranch(editing)) {
                const editStatus = document.getElementById("chat-edit-status");
                if (editStatus) {
                    if (editStatus.children[0]) editStatus.children[0].textContent = "The before-edit history copy could not be saved. Your original conversation is still intact; try again or cancel.";
                    editStatus.hidden = false;
                }
                return;
            }
            S.chatMessages = S.chatMessages.slice(0, editing.index + 1);
            S.chatMessages[editing.index] = { ...S.chatMessages[editing.index], content: trimmedText };
            S.chatCompactions = S.chatCompactions.filter(record => record.end <= editing.index);
            S.pendingEdit = null;
            const editStatus = document.getElementById("chat-edit-status");
            if (editStatus) { if (editStatus.children[0]) editStatus.children[0].textContent = ""; editStatus.hidden = true; }
            renderConversationMessages(editing.index);
            I.saveCurrentConversation();
        } else if (!retry) {
            S.chatMessages.push({ role: "user", content: trimmedText });
            renderConversationMessages(S.chatMessages.length - 1);
            I.saveCurrentConversation();
        }

        const chatInput = document.getElementById("chat-input");
        if (!retry) {
            chatInput.value = "";
            chatInput.style.height = "auto";
        }

        S.chatStreaming = true;
        S.streamingCheckpoint = {
            active: true, replacementIndex, content: "", reasoning: "", sources: [], status: "streaming", error: "",
            userText: trimmedText, metadata: {}, toolMessages: [],
        };
        I.requestWorkspaceCheckpoint({ reason: "response-started" });
        I.notifyWorkspaceChange();
        I.showChatSendButton(false);
        renderChatTypingIndicator();
        restoreChatScrollPosition();

        const body = I.buildChatBody(replacementIndex >= 0 ? S.chatMessages.slice(0, replacementIndex) : S.chatMessages, "", true);
        I.renderContextBudget({ message: body.web_search ? "Waiting for web results before measuring context…" : "Checking context before generating…" });

        S.chatAbortController = new AbortController();
        let bubble = null;
        let fullContent = "";
        let fullReasoning = "";
        let responseSources = [];
        let status = "complete";
        let error = "";
        const responseMetadata = {};
        const toolMessages = [];
        let reader = null;

        try {
            // One date/time exchange per answer, then require a final response.
            for (let round = 0; round < 2; round += 1) {
                S.chatAbortController.signal.throwIfAborted();
                const toolCalls = [];
                let roundFinishReason = "";
                const resp = await fetch("/api/chat/completions", {
                    method: "POST",
                    headers: S.getApiAuthorizationHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(body),
                    signal: S.chatAbortController.signal,
                });

                if (!I.workspaceMutationAllowed(ownerEpoch)) throw Object.assign(new Error("Chat ownership changed"), { name: "AbortError" });

                removeChatTypingIndicator();

                if (!resp.ok) {
                    const errText = await resp.text().catch(() => resp.statusText);
                    throw new Error(`HTTP ${resp.status} - ${errText}`);
                }

                if (!resp.body) {
                    throw new Error("Response body is empty.");
                }
                bubble = renderChatMessage("assistant", "");
                reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let streamDone = false;
                let receivedFinish = false;

                while (!streamDone) {
                    const { done, value } = await reader.read();
                    if (!I.workspaceMutationAllowed(ownerEpoch)) throw Object.assign(new Error("Chat ownership changed"), { name: "AbortError" });
                    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    if (done && buffer) {
                        lines.push(buffer);
                        buffer = "";
                    }

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith("data:")) continue;
                        const data = trimmed.slice(5).trimStart();
                        if (data === "[DONE]") {
                            streamDone = true;
                            setChatWebStatus(bubble, "");
                            break;
                        }

                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        } catch (e) {
                            console.debug("Skipping malformed chat stream chunk", e);
                            continue;
                        }
                        if (parsed.type === "context_budget") {
                            I.renderContextBudget(parsed);
                            continue;
                        }
                        if (parsed.type === "web_status") {
                            setChatWebStatus(bubble, parsed.content || "");
                            continue;
                        }
                        if (parsed.type === "web_sources") {
                            responseSources = parsed.sources || [];
                            S.streamingCheckpoint.sources = responseSources;
                            I.requestWorkspaceCheckpoint({ reason: "response-progress" });
                            renderChatSources(bubble, responseSources);
                            continue;
                        }
                        if (parsed.error) {
                            const message = parsed.error.message || "Unknown error";
                            throw new Error(message);
                        }
                        const delta = parsed.choices?.[0]?.delta;
                        const finishReason = parsed.choices?.[0]?.finish_reason;
                        if (finishReason) {
                            roundFinishReason = finishReason;
                            receivedFinish = true;
                            updateResponseMetadata(responseMetadata, parsed, finishReason);
                            S.streamingCheckpoint.status = finishReason === "length" ? "length" : "complete";
                            if (finishReason === "length") status = "length";
                        }
                        updateResponseMetadata(responseMetadata, parsed);
                        S.streamingCheckpoint.metadata = responseMetadata;
                        if (delta?.tool_calls !== undefined) {
                            if (!body.tools?.length) throw new Error("The model requested a tool while Chat tools are disabled.");
                            window.LlamaGui.chatTools.collectCalls(toolCalls, delta.tool_calls);
                        }
                        const reasoningDelta = I.getChatDeltaText(delta, ["reasoning_content", "reasoning"]);
                        if (reasoningDelta) {
                            fullReasoning += reasoningDelta;
                            S.streamingCheckpoint.reasoning = fullReasoning;
                            appendChatReasoningStreamToken(bubble, reasoningDelta);
                            followChatOutput();
                        }
                        const contentDelta = I.getChatDeltaText(delta, ["content"]);
                        if (contentDelta) {
                            fullContent += contentDelta;
                            S.streamingCheckpoint.content = fullContent;
                            appendChatStreamToken(bubble, contentDelta);
                            followChatOutput();
                        }
                        if (reasoningDelta || contentDelta) I.requestWorkspaceCheckpoint({ reason: "response-progress" });
                    }
                    if (done) {
                        if (!streamDone && !receivedFinish) throw new Error("Connection closed before the response completed.");
                        break;
                    }
                }

                await reader.cancel().catch(e => console.debug("Failed to close chat stream reader", e));
                reader = null;
                // Conversation changes await this stream. Check abort after the last
                // await before executing tools and removing the provisional message.
                S.chatAbortController.signal.throwIfAborted();
                if (!I.workspaceMutationAllowed(ownerEpoch)) throw Object.assign(new Error("Chat ownership changed"), { name: "AbortError" });
                if (toolCalls.length || roundFinishReason === "tool_calls") {
                    if (round > 0) throw new Error("The model requested more tools instead of answering. Retry the reply.");
                    if (!toolCalls.length || roundFinishReason !== "tool_calls") {
                        throw new Error("The date/time tool call was incomplete. Retry the reply.");
                    }
                    const results = window.LlamaGui.chatTools.executeCalls(toolCalls);
                    toolMessages.push({
                        role: "assistant", content: fullContent, tool_calls: toolCalls,
                        ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
                    }, ...results);
                    S.streamingCheckpoint.toolMessages = toolMessages;
                    I.requestWorkspaceCheckpoint({ reason: "response-progress" });
                    body.messages.push(...toolMessages);
                    body.tool_choice = "none";
                    fullContent = "";
                    fullReasoning = "";
                    S.streamingCheckpoint.content = "";
                    S.streamingCheckpoint.reasoning = "";
                    for (const key of Object.keys(responseMetadata)) delete responseMetadata[key];
                    bubble.closest(".chat-message").remove();
                    bubble = null;
                    renderChatTypingIndicator();
                    continue;
                }
                break;
            }

            if (!fullContent && !fullReasoning) throw new Error("The server returned no answer.");
        } catch (e) {
            removeChatTypingIndicator();
            if (e.name === "AbortError") {
                status = "stopped";
            } else {
                status = "failed";
                error = e.message || "Request failed.";
            }
        } finally {
            if (reader) await reader.cancel().catch((e) => console.debug("Failed to close chat stream reader", e));
            removeChatTypingIndicator();
            if (I.workspaceMutationAllowed(ownerEpoch)) {
                S.streamingCheckpoint.status = status;
                S.streamingCheckpoint.error = error;
                finalizeAssistantResponse(fullContent, fullReasoning, responseSources, status, error, replacementIndex, responseMetadata, toolMessages, ownerEpoch);
            }
            S.chatStreaming = false;
            S.chatAbortController = null;
            I.showChatSendButton(true);
            I.updateChatAvailability(I.isServerRunning());
            if (S.chatScrollState?.follow) followChatOutput();
            else updateChatJumpButton(true);
            if (status !== "failed") I.scheduleContextPreview(true);
            const chatInput = document.getElementById("chat-input");
            if (chatInput) chatInput.focus();
            I.notifyWorkspaceChange();
        }
        return I.workspaceMutationAllowed(ownerEpoch);
    }

    function stopStream() {
        if (S.chatAbortController) {
            S.chatAbortController.abort();
        }
        removeChatTypingIndicator();
    }

    async function abortActiveStream() {
        S.sendAttemptToken += 1;
        I.cancelContextPreview();
        const compactPending = S.compactionPromise;
        if (S.compactionController) S.compactionController.abort();
        if (compactPending) await compactPending;
        const pending = S.chatStreamPromise;
        stopStream();
        if (pending) {
            await pending.catch((error) => console.debug("Chat stream did not settle cleanly", error));
        }
        return true;
    }

    function addModelTransitionDivider(previousLabel, nextLabel) {
        const container = document.getElementById("chat-messages");
        if (!container) return;
        const previousScroll = captureChatScrollState();
        const divider = document.createElement("div");
        divider.className = "chat-model-divider";
        divider.setAttribute("role", "separator");
        const from = String(previousLabel || "previous model").trim() || "previous model";
        const to = String(nextLabel || "new model").trim() || "new model";
        divider.textContent = `Model switched: ${from} → ${to}`;
        container.appendChild(divider);
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "none";
        if (previousScroll.follow) followChatOutput();
        else restoreChatScrollPosition();
    }

    function undoMessage() {
        if (!I.workspaceMutationAllowed() || S.chatStreaming || S.compactionController || S.chatMessages.length === 0) return false;
        if (S.currentConversationId && !I.invalidateWorkspace()) return false;
        const container = document.getElementById("chat-messages");
        if (!container) return false;
        const previousMessages = S.chatMessages.slice();
        const previousCompactions = S.chatCompactions.slice();
        S.chatMessages.pop();
        while (S.chatCompactions.length && !compaction.valid(S.chatCompactions.at(-1), S.chatMessages)) S.chatCompactions.pop();
        const msgs = container.querySelectorAll(".chat-message");
        if (msgs.length > 0) msgs[msgs.length - 1].remove();

        if (S.chatMessages.length === 0) {
            const empty = document.getElementById("chat-empty");
            if (empty) empty.style.display = "";
            if (S.currentConversationId) {
                const conversations = I.getStoredConversations();
                if (!I.saveConversationsToStorage(conversations.filter(c => c.id !== S.currentConversationId))) {
                    S.chatMessages = previousMessages;
                    S.chatCompactions = previousCompactions;
                    return false;
                }
                S.currentConversationId = null;
                S.workspaceConversationTitle = null;
                S.workspaceConversationTitleCustom = false;
                I.renderHistoryList();
            }
        } else {
            if (!I.saveCurrentConversation()) {
                S.chatMessages = previousMessages;
                S.chatCompactions = previousCompactions;
                return false;
            }
        }
        renderConversationMessages(Math.max(0, S.chatMessages.length - 1));
        I.requestWorkspaceCheckpoint({ reason: "undo-message" });
        I.notifyWorkspaceChange();
        return true;
    }

    function regenerateResponse() {
        if (!I.workspaceMutationAllowed() || S.chatStreaming || S.compactionController || !I.isServerRunning() || S.chatMessages.length === 0) return Promise.resolve(false);
        const lastIndex = S.chatMessages.length - 1;
        const userIndex = S.chatMessages[lastIndex].role === "assistant" ? lastIndex - 1 : lastIndex;
        const userMessage = S.chatMessages[userIndex];
        if (!userMessage || userMessage.role !== "user") return Promise.resolve();
        return sendMessage(userMessage.content, true);
    }

    Object.assign(I, {
        sendMessage,
        getChatMessagesContainer,
        isChatNearBottom,
        updateChatJumpButton,
        captureChatScrollState,
        followChatOutput,
        restoreChatScrollPosition,
        jumpToLatest,
        wireChatScrollControls,
        updateResponseMetadata,
        editUserMessage,
        cancelEdit,
        discardPendingEdit,
        createConversationId,
        persistEditBranch,
        finalizeAssistantResponse,
        renderConversationMessages,
        runMessage,
        stopStream,
        abortActiveStream,
        addModelTransitionDivider,
        undoMessage,
        regenerateResponse,
    });
})();
