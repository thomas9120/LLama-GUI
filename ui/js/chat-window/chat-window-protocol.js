// Chat-window wire constants, safe JSON copies, and allowlisted state projections.
// Loading only registers helpers; logging/window access occurs when called.
(function () {
    "use strict";

    const PROTOCOL = "llama-gui-chat-window";
    const PROTOCOL_VERSION = 1;
    const SNAPSHOT_VERSION = 1;
    const SNAPSHOT_KIND = "llama-gui-chat-workspace";
    const RECOVERY_VERSION = 1;
    const DEFAULT_LOCK_NAME = "llama-gui:chat-workspace";
    const DEFAULT_RECOVERY_KEY = "llama-gui:chat-recovery:v1";

    // Sampler fields come from Chat's existing control definitions. Keep only
    // launch fields that Chat reads but never writes here.
    const CHAT_READONLY_SETTING_FIELDS = Object.freeze(["ctx_size", "alias", "reasoning_format"]);
    // "prompt_tokens" and the other token accounting fields are valid Chat
    // metadata.  Reject credential-shaped names only; settings are separately
    // protected by the explicit allowlists below.
    const SECRET_KEY = /^(?:api[_-]?key|hf[_-]?token|access[_-]?token|auth(?:orization)?|password|passwd|secret|credential|cookie|bearer)$/i;
    const RUNTIME_FIELDS = Object.freeze([
        "tool", "source", "slot", "preset", "model", "model_name", "model_path", "model_alias",
        "alias", "backend", "phase", "busy", "status", "running", "ready", "healthy", "loaded",
        "generation", "runtime_generation", "active_runtime", "activeRuntime", "external_chat_target",
        "externalChatTarget", "external_target", "target", "host", "port", "connected", "reachable",
        "message", "error",
    ]);
    const INFERENCE_FIELDS = Object.freeze([
        "targetKey", "seq", "sources", "session", "context", "requests", "slots", "speed",
        "contextLevel", "baselinePending",
    ]);
    const INFERENCE_SESSION_FIELDS = Object.freeze(["prompt", "generated", "total"]);
    const INFERENCE_SPEED_FIELDS = Object.freeze(["prompt", "generated", "promptIsLive", "generatedIsLive"]);
    const INFERENCE_CONTEXT_FIELDS = Object.freeze(["percent", "used", "size", "capacity", "level"]);
    const INFERENCE_REQUEST_FIELDS = Object.freeze(["processing", "queued", "processingBest"]);
    const INFERENCE_SOURCE_FIELDS = Object.freeze(["metrics", "slots"]);
    const INFERENCE_SLOTS_FIELDS = Object.freeze(["busy", "total"]);

    function getWindow(options) {
        return options && options.window ? options.window
            : (typeof window !== "undefined" ? window : null);
    }

    function getConsole(options) {
        const target = getWindow(options);
        return target && target.console ? target.console : (typeof console !== "undefined" ? console : null);
    }

    function debug(options, message, error) {
        const logger = getConsole(options);
        if (logger && typeof logger.debug === "function") logger.debug(message, error);
    }

    function warn(options, message, error) {
        const logger = getConsole(options);
        if (logger && typeof logger.warn === "function") logger.warn(message, error);
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isJsonValue(value, seen) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (typeof value !== "object") return false;
        if (seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.every(item => isJsonValue(item, seen));
        return Object.keys(value).every(key => !SECRET_KEY.test(key) && isJsonValue(value[key], seen));
    }

    function cloneJson(value, options, label) {
        if (!isJsonValue(value, new Set())) {
            warn(options, `${label || "JSON value"} contains unsupported or sensitive data`);
            return null;
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            warn(options, `Unable to clone ${label || "JSON value"}`, error);
            return null;
        }
    }

    function pickJson(value, fields, options, label) {
        if (value === null || value === undefined || typeof value !== "object") {
            return value === undefined ? null : cloneJson(value, options, label);
        }
        if (Array.isArray(value)) return value.map(item => pickJson(item, fields, options, label));
        const picked = {};
        for (const field of fields) {
            if (Object.prototype.hasOwnProperty.call(value, field)) {
                const item = value[field];
                const nestedFields = field === "active_runtime" || field === "activeRuntime"
                    || field === "target" || field === "external_chat_target" || field === "externalChatTarget"
                    || field === "external_target" ? RUNTIME_FIELDS
                    : field === "session" ? INFERENCE_SESSION_FIELDS
                        : field === "speed" ? INFERENCE_SPEED_FIELDS
                            : field === "context" ? INFERENCE_CONTEXT_FIELDS
                                : field === "requests" ? INFERENCE_REQUEST_FIELDS
                                    : field === "sources" ? INFERENCE_SOURCE_FIELDS
                                        : field === "slots" ? INFERENCE_SLOTS_FIELDS : null;
                if (nestedFields) {
                    picked[field] = pickJson(item, nestedFields, options, `${label || "state"}.${field}`);
                } else {
                    const safe = cloneJson(item, options, `${label || "state"}.${field}`);
                    if (safe !== null || item === null) picked[field] = safe;
                }
            }
        }
        return picked;
    }

    function result(ok, reason, extra) {
        return Object.assign({ ok: Boolean(ok), reason: reason || (ok ? "ok" : "unavailable") }, extra || {});
    }

    const root = typeof window !== "undefined" ? window : globalThis;
    root.LlamaGui = root.LlamaGui || {};
    root.LlamaGui._chatWindowInternal = { protocol: Object.freeze({
        PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION,
        DEFAULT_LOCK_NAME, DEFAULT_RECOVERY_KEY, CHAT_READONLY_SETTING_FIELDS,
        SECRET_KEY, RUNTIME_FIELDS, INFERENCE_FIELDS,
        getWindow, debug, warn, isObject, isJsonValue, cloneJson, pickJson, result,
    }) };
})();
