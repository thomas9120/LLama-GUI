// Chat package (4/8): request construction - thinking params, message shaping, delta text, body assembly.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const compaction = window.LlamaGui.chatCompaction;

    function getChatThinkingParams() {
        const effort = I.getChatThinkingEffort();
        if (effort === "auto") return {};
        if (effort === "off") {
            return {
                reasoning_effort: "none",
                chat_template_kwargs: {
                    enable_thinking: false,
                    reasoning_effort: "none",
                },
            };
        }
        // Top-level reasoning_effort is honored natively by llama.cpp b10434+
        // (and takes final precedence over the server default); the nested
        // chat_template_kwargs copy stays as the fallback for older builds
        // that ignored top-level values other than "none". Both are harmless
        // together, so we send them through the whole compatibility window.
        return {
            reasoning_effort: effort,
            chat_template_kwargs: {
                enable_thinking: true,
                reasoning_effort: effort,
            },
        };
    }

    function getChatRequestMessages(messages) {
        return window.LlamaGui.chatTools.requestMessages(messages);
    }

    function getChatDeltaText(delta, keys) {
        if (!delta) return "";
        for (const key of keys) {
            const value = delta[key];
            if (typeof value === "string" && value) return value;
        }
        return "";
    }

    function shouldExtractEmbeddedReasoning() {
        const values = S.flagCore ? S.flagCore.getFlagValues() : {};
        const format = values.reasoning_format || "auto";
        return format === "auto" || format === "deepseek";
    }

    function getMessagePreviewText(message) {
        if (!message) return "";
        const content = String(message.content || "").trim();
        const text = content || String(message.reasoning || "").trim();
        return text.replace(/\n/g, " ").slice(0, 60);
    }

    function getExternalTarget() {
        const latestStatus = S.getLatestStatus ? S.getLatestStatus() : null;
        const target = latestStatus && latestStatus.external_chat_target;
        return target && target.connected ? target : null;
    }

    function isServerRunning() {
        const lifecycle = S.getLifecycleSnapshot ? S.getLifecycleSnapshot() : null;
        if (lifecycle && lifecycle.activeRuntime && lifecycle.activeRuntime.tool === "llama-server") {
            return lifecycle.ready === true;
        }
        const latestStatus = S.getLatestStatus ? S.getLatestStatus() : null;
        // Lifecycle clears the runtime before the shared status poll catches up
        // after Stop. Only fall back when lifecycle state is unavailable.
        if (!lifecycle && latestStatus && latestStatus.running && latestStatus.active_process_tool === "llama-server") {
            return true;
        }
        // A llama-server registered on the API tab is just as good a chat target
        // as one this GUI launched.
        return Boolean(getExternalTarget());
    }

    function buildChatBody(history, draft = "", includeUsage = false) {
        const messages = [];
        const systemPrompt = [
            (document.getElementById("chat-system-prompt")?.value || "").trim(),
            window.LlamaGui.chatTools.getInstructions(),
        ].filter(Boolean).join("\n\n");
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push(...getChatRequestMessages(compaction.workingMessages(history, S.chatCompactions.at(-1))));
        if (draft.trim()) messages.push({ role: "user", content: draft.trim() });
        const body = {
            model: I.getChatModelName(), messages, stream: true,
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
            ...I.getChatSamplerParams(), ...getChatThinkingParams(),
        };
        if (I.isChatWebSearchEnabled()) {
            body.web_search = true;
            body.web_search_max_results = I.getChatWebSearchMaxResults();
        }
        const tools = window.LlamaGui.chatTools.getDefinitions();
        if (tools.length) body.tools = tools;
        return body;
    }

    Object.assign(I, {
        getChatThinkingParams,
        getChatRequestMessages,
        getChatDeltaText,
        shouldExtractEmbeddedReasoning,
        getMessagePreviewText,
        getExternalTarget,
        isServerRunning,
        buildChatBody,
    });
})();
