// Chat package (1/8): shared state object, package constants, tolerant
// storage helpers, and configure(). Loaded first; sibling files attach to
// window.LlamaGui._chatInternal and read shared state through it.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = {};
    window.LlamaGui._chatInternal = I;

    // Formerly the closure variables of the single-file chat-ui.js IIFE.
    const S = {
        // Injected by app.js through configure().
        flagCore: null,
        confirmAction: null,
        getLatestStatus: null,
        getLifecycleSnapshot: null,
        snapshotStatsBaseline: null,
        getApiAuthorizationHeaders: (headers) => headers || {},
        switchTab: () => {},

        // Mutable chat/workspace state shared across the package.
        chatMessages: [],
        chatStreaming: false,
        chatAbortController: null,
        chatStreamPromise: null,
        sendPreflightPromise: null,
        sendAttemptToken: 0,
        currentConversationId: null,
        workspaceConversationTitle: null,
        workspaceConversationTitleCustom: false,
        chatFocusMode: false,
        chatPanelLayouts: [],
        contextTimer: null,
        contextController: null,
        contextKey: null,
        contextRevision: 0,
        chatCompactions: [],
        compactionController: null,
        compactionPromise: null,
        compactionKey: null,
        latestContextBudget: null,
        latestContextBodyKey: null,
        pendingEdit: null,
        chatScrollState: null,
        autoCompactionAttempted: false,
        chatHistoryFilter: "",
        characterImportPending: false,
        workspaceConfig: { checkpoint: null, invalidate: null, onChange: null, detachedView: false },
        workspaceOwned: true,
        workspaceSuspended: false,
        workspaceHostAvailable: true,
        workspaceEpoch: 0,
        workspaceCheckpointTimer: null,
        workspaceCheckpointPending: false,
        workspaceTransferSave: false,
        confirmationPending: 0,
        streamingCheckpoint: null,
        workspaceRestoreInProgress: false,
        beforeUnloadInstalled: false,

        // llama.cpp b10434+ reports chat_template_caps.supports_reasoning_effort
        // on /props. The cap is boolean-only (it cannot say which levels a model
        // accepts), so an unsupported template only earns an explanatory hint —
        // never a disabled control. Fetched once per server generation.
        templateCapsKey: null,
        templateCapsRequest: null,
        historyRetentionNotice: false,
    };
    I.state = S;

    // Package constants: storage keys, transfer schema shapes, numeric input map.
    I.consts = {
        CHAT_CONVERSATIONS_STORAGE_KEY: "llama_gui_conversations",
        CHAT_SETTINGS_COLLAPSED_STORAGE_KEY: "llama_gui_chat_settings_collapsed",
        CHAT_HISTORY_COLLAPSED_STORAGE_KEY: "llama_gui_chat_history_collapsed",
        CHAT_WEB_SEARCH_STORAGE_KEY: "llama_gui_chat_web_search_enabled",
        CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY: "llama_gui_chat_web_search_max_results",
        CHAT_AUTO_COMPACTION_STORAGE_KEY: "llama_gui_chat_auto_compaction",
        CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS: 5,
        CHAT_WEB_SEARCH_MIN_RESULTS: 1,
        CHAT_WEB_SEARCH_MAX_RESULTS: 10,
        CHAT_THINKING_EFFORTS: ["auto", "off", "low", "medium", "high", "xhigh"],
        CHAT_MAX_STORED_CONVERSATIONS: 50,
        CHAT_CONSTRAINED_LAYOUT_QUERY: "(max-width: 1320px)",
        CHAT_WORKSPACE_SCHEMA_VERSION: 1,
        CHAT_WORKSPACE_KIND: "llama-gui-chat-workspace",
        CHAT_MESSAGE_KEYS: [
            "role", "content", "reasoning", "reasoning_content", "sources", "status", "error", "metadata",
            "toolMessages", "tool_calls", "tool_call_id", "name", "id", "function", "versions", "versionIndex",
        ],
        CHAT_MESSAGE_ROLES: ["user", "assistant", "tool", "system", "developer"],
        CHAT_SOURCE_KEYS: ["url", "title", "index", "snippet", "domain", "date"],
        CHAT_TOOL_CALL_KEYS: ["id", "type", "function"],
        CHAT_TOOL_FUNCTION_KEYS: ["name", "arguments"],
        CHAT_METADATA_KEYS: [
            "usage", "timings", "stop_reason", "stopReason", "finish_reason", "finishReason",
            "prompt_tokens", "completion_tokens", "total_tokens", "promptTokens", "completionTokens", "totalTokens",
            "tokens_per_second", "tokensPerSecond", "completion_tokens_per_second", "completionTokensPerSecond",
            "predicted_per_second", "predictedPerSecond", "prompt_per_second", "promptPerSecond",
            "prompt_n", "predicted_n", "prompt_ms", "predicted_ms", "time_to_first_token",
        ],
        CHAT_METADATA_NESTED_KEYS: [
            "prompt_tokens", "completion_tokens", "total_tokens", "promptTokens", "completionTokens", "totalTokens",
            "tokens_per_second", "tokensPerSecond", "completion_tokens_per_second", "completionTokensPerSecond",
            "predicted_per_second", "predictedPerSecond", "prompt_per_second", "promptPerSecond",
            "prompt_n", "predicted_n", "prompt_ms", "predicted_ms", "time_to_first_token",
        ],
        CHAT_TRANSFER_METADATA_KEYS: [
            "transferId", "sourceInstanceId", "destinationInstanceId", "revision", "epoch", "reason",
        ],
        CHAT_NUMERIC_INPUTS: {
            "chat-num-temp": { flag: "temperature", integer: false },
            "chat-num-top-p": { flag: "top_p", integer: false },
            "chat-num-top-k": { flag: "top_k", integer: true },
            "chat-num-min-p": { flag: "min_p", integer: false },
            "chat-num-repeat": { flag: "repeat_penalty", integer: false },
            "chat-num-max-tokens": { flag: "n_predict", integer: true },
        },
    };

    // localStorage may be blocked entirely (e.g. "block all cookies"). The
    // Chat tab must still work with per-session defaults, so every storage
    // read/write goes through these tolerant helpers instead of throwing and
    // aborting init() before the button handlers are wired.
    function getStoredItem(storageKey) {
        try {
            return localStorage.getItem(storageKey);
        } catch (e) {
            console.debug("Chat storage read failed", e);
            return null;
        }
    }

    function setStoredItem(storageKey, value) {
        try {
            localStorage.setItem(storageKey, value);
            return true;
        } catch (e) {
            console.warn("Chat storage write failed", e);
            return false;
        }
    }

    function configure(options) {
        S.flagCore = options.flagCore;
        S.confirmAction = options.confirmAction;
        S.getLatestStatus = options.getLatestStatus;
        S.getLifecycleSnapshot = options.getLifecycleSnapshot || S.getLifecycleSnapshot;
        S.snapshotStatsBaseline = options.snapshotStatsBaseline;
        S.getApiAuthorizationHeaders = options.getApiAuthorizationHeaders || S.getApiAuthorizationHeaders;
        S.switchTab = options.switchTab || S.switchTab;
    }

    Object.assign(I, { getStoredItem, setStoredItem, configure });
})();
