(function () {
    window.LlamaGui = window.LlamaGui || {};

    const STORAGE_KEY = "llama_gui_chat_datetime_enabled";
    const LABEL = "Current Date & Time";
    let enabled = false;
    let canMutate = () => true;
    let workspaceChange = null;
    try {
        enabled = localStorage.getItem(STORAGE_KEY) === "true";
    } catch (error) {
        console.debug("Could not read the date/time tool preference", error);
    }

    function configureWorkspace(options = {}) {
        canMutate = typeof options.canMutate === "function" ? options.canMutate : () => true;
        workspaceChange = typeof options.onChange === "function" ? options.onChange : null;
    }

    function setEnabled(value, options = {}) {
        if (!canMutate()) return false;
        enabled = value === true;
        if (options.persist !== false) {
            try {
                localStorage.setItem(STORAGE_KEY, String(enabled));
            } catch (error) {
                console.debug("Date/time tool preference is session-only", error);
            }
        }
        workspaceChange?.();
        return true;
    }

    function isEnabled() { return enabled; }

    function getDefinitions() {
        return enabled ? [{
            type: "function",
            function: {
                name: "get_datetime",
                description: "Get the current local date and time in ISO 8601 format, with the user's IANA time zone name. Use this when you need the current date or time.",
                parameters: { type: "object", properties: {}, required: [] },
            },
        }] : [];
    }

    function getInstructions() {
        return enabled ? "You can check the user's browser clock with get_datetime. Call it before answering questions that depend on the current date or time, including relative dates such as today, tomorrow, or latest news. Do not infer the current date from training data or web search excerpts. After a clock result is provided, use it to anchor dates in your answer." : "";
    }

    function init(onChange) {
        const checkbox = document.getElementById("chat-datetime-enabled");
        if (!checkbox) return;
        checkbox.checked = enabled;
        checkbox.onchange = () => {
            if (!setEnabled(checkbox.checked)) {
                checkbox.checked = enabled;
                return;
            }
            onChange?.();
        };
    }

    function currentDateTime() {
        const now = new Date();
        const pad = value => String(value).padStart(2, "0");
        const offset = -now.getTimezoneOffset();
        const minutes = Math.abs(offset);
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        return {
            result: `${date}T${time}${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
    }

    // Tool arguments, names and IDs can span multiple SSE chunks.
    function collectCalls(calls, deltas) {
        if (!Array.isArray(deltas)) throw new Error("The server returned invalid tool calls.");
        for (const delta of deltas) {
            if (!Number.isInteger(delta?.index) || delta.index < 0 || delta.index >= 4
                || (delta.type && delta.type !== "function")) {
                throw new Error("The server returned invalid tool calls.");
            }
            const call = calls[delta.index] || { id: "", type: "function", function: { name: "", arguments: "" } };
            for (const [target, key, fragment, limit] of [
                [call, "id", delta.id, 256],
                [call.function, "name", delta.function?.name, 64],
                [call.function, "arguments", delta.function?.arguments, 4096],
            ]) {
                if (fragment === undefined || fragment === null) continue;
                if (typeof fragment !== "string" || target[key].length + fragment.length > limit) {
                    throw new Error("The server returned an invalid or oversized tool call.");
                }
                target[key] += fragment;
            }
            calls[delta.index] = call;
        }
    }

    function executeCalls(calls) {
        if (!enabled) throw new Error("Current Date & Time is disabled. Enable it in Chat Settings to retry.");
        const ids = new Set();
        // Validate the entire batch before executing anything. No server/shell tools are dispatched here.
        for (const call of calls) {
            if (!call?.id || ids.has(call.id) || call.function?.name !== "get_datetime") {
                throw new Error("Chat only supports the Current Date & Time tool.");
            }
            ids.add(call.id);
            let args;
            try {
                args = JSON.parse(call.function.arguments || "{}");
            } catch (error) {
                console.debug("Invalid date/time tool arguments", error);
                throw new Error("The model returned invalid date/time tool arguments. Retry the reply.");
            }
            if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
                throw new Error("Current Date & Time does not accept arguments. Retry the reply.");
            }
        }
        const content = JSON.stringify(currentDateTime());
        return calls.map(call => ({ role: "tool", tool_call_id: call.id, content }));
    }

    // Keep each tool exchange attached to its answer in storage, while expanding it
    // into standard assistant/tool messages for requests and context measurements.
    function requestMessages(messages) {
        return messages.flatMap(msg => {
            const exchange = msg.role === "assistant" && Array.isArray(msg.toolMessages) ? msg.toolMessages : [];
            const reasoning = typeof msg.reasoning === "string" ? msg.reasoning
                : (typeof msg.reasoning_content === "string" ? msg.reasoning_content : "");
            if (msg.role === "assistant" && !msg.content && !reasoning) return exchange;
            return [...exchange, {
                role: msg.role, content: msg.content,
                ...(msg.role === "assistant" && reasoning ? { reasoning_content: reasoning } : {}),
            }];
        });
    }

    function renderResults(bubble, messages) {
        const results = (messages || []).filter(msg => msg.role === "tool");
        if (!results.length) return;
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `Used ${LABEL}`;
        details.appendChild(summary);
        for (const message of results) {
            const value = document.createElement("p");
            try {
                const result = JSON.parse(message.content);
                value.textContent = `${result.result} (${result.timezone || "local timezone"})`;
            } catch (error) {
                console.debug("Could not display a stored date/time result", error);
                value.textContent = "Saved date/time result is unavailable.";
            }
            details.appendChild(value);
        }
        bubble.closest(".chat-message-content").appendChild(details);
    }

    window.LlamaGui.chatTools = {
        configureWorkspace, setEnabled, isEnabled, getDefinitions, getInstructions, init, currentDateTime,
        collectCalls, executeCalls, requestMessages, renderResults,
    };
})();
