// Shared Chat-window bootstrap helpers; browser access occurs only when called.
(function () {
    "use strict";
    const root = typeof window !== "undefined" ? window : globalThis;
    const I = root.LlamaGui._chatWindowInternal;
    const { getWindow, debug } = I.protocol;

    const DETACHED_QUERY_PARAM = "chat-window";

    function getOrigin(options) {
        const target = getWindow(options);
        if (options && typeof options.origin === "string") return options.origin;
        if (target && target.location && typeof target.location.origin === "string") return target.location.origin;
        return "";
    }

    function randomId(prefix, options) {
        const target = getWindow(options);
        const cryptoObject = target && target.crypto;
        if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
            try { return `${prefix}-${cryptoObject.randomUUID()}`; } catch (error) { debug(options, "randomUUID unavailable", error); }
        }
        const random = Math.random().toString(36).slice(2);
        return `${prefix}-${Date.now().toString(36)}-${random}`;
    }

    function getStorage(options) {
        if (options && Object.prototype.hasOwnProperty.call(options, "storage")) return options.storage;
        const target = getWindow(options);
        if (!target) return null;
        try { return target.localStorage; } catch (error) {
            debug(options, "localStorage is unavailable", error);
            return null;
        }
    }

    function isDetachedView(target) {
        const current = target || (typeof window !== "undefined" ? window : null);
        try {
            const href = current && current.location && typeof current.location.href === "string"
                ? current.location.href : "";
            if (!href) return false;
            if (typeof URL === "function") return new URL(href).searchParams.get(DETACHED_QUERY_PARAM) === "1";
            const query = href.split("?", 2)[1]?.split("#", 1)[0] || "";
            return query.split("&").some(part => {
                const [key, value] = part.split("=", 2);
                return decodeURIComponent(key || "") === DETACHED_QUERY_PARAM && decodeURIComponent(value || "") === "1";
            });
        } catch (error) {
            if (current && current.console && typeof current.console.debug === "function") {
                current.console.debug("Unable to determine Chat window mode", error);
            }
            return false;
        }
    }

    function isClosedWindow(value) {
        try { return !value || value.closed === true; } catch (error) { return true; }
    }

    function safeRead(getter, fallback, logger) {
        try { return typeof getter === "function" ? getter() : fallback; }
        catch (error) {
            if (logger && typeof logger.debug === "function") logger.debug("Chat window host read failed", error);
            return fallback;
        }
    }

    function waitForPeer(coordinator, timeoutMs = 10000) {
        if (coordinator.isPeerVerified()) return Promise.resolve(true);
        const limit = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 10000;
        return new Promise(resolve => {
            let finished = false;
            const finish = value => {
                if (finished) return;
                finished = true;
                if (unsubscribe) unsubscribe();
                if (timer) clearInterval(timer);
                resolve(Boolean(value));
            };
            const unsubscribe = coordinator.subscribe(() => {
                if (coordinator.isPeerVerified()) finish(true);
            });
            const timer = typeof setInterval === "function" ? setInterval(() => {
                if (coordinator.isPeerVerified()) finish(true);
            }, 50) : null;
            if (typeof setTimeout === "function") setTimeout(() => finish(coordinator.isPeerVerified()), limit);
            else finish(coordinator.isPeerVerified());
        });
    }

    function showDetachedError(target, title, message, options = {}) {
        const doc = target && target.document;
        const placeholder = doc?.getElementById("chat-window-placeholder");
        const layout = doc?.getElementById("chat-layout");
        const heading = placeholder?.querySelector("h3");
        const detail = placeholder?.querySelector("p");
        const showWindow = doc?.getElementById("btn-chat-show-window");
        const returnHere = doc?.getElementById("btn-chat-return-here");
        const fullGui = doc?.getElementById("chat-window-open-full-gui");
        const headerActions = doc?.querySelectorAll("#section-chat .chat-header-actions button");
        if (heading) {
            heading.textContent = title;
            heading.tabIndex = -1;
        }
        if (detail) detail.textContent = message;
        if (layout) layout.hidden = true;
        if (placeholder) placeholder.hidden = false;
        if (showWindow) {
            showWindow.hidden = true;
            showWindow.disabled = true;
            showWindow.setAttribute("aria-disabled", "true");
        }
        if (returnHere) {
            returnHere.hidden = true;
            returnHere.disabled = true;
            returnHere.setAttribute("aria-disabled", "true");
        }
        headerActions?.forEach(button => {
            button.disabled = true;
            button.setAttribute("aria-disabled", "true");
        });
        if (fullGui) {
            fullGui.hidden = options.fullGuiLink !== true;
            if (options.fullGuiLink === true) {
                try {
                    const url = new URL(target.location.href);
                    url.searchParams.delete(DETACHED_QUERY_PARAM);
                    fullGui.href = url.href;
                } catch (error) {
                    fullGui.hidden = true;
                    target.console?.debug?.("Unable to build full GUI recovery link", error);
                }
            }
        }
        doc?.body?.setAttribute("data-chat-window-error", "true");
        heading?.focus?.();
    }

    I.bootstrap = Object.freeze({
        DETACHED_QUERY_PARAM, getOrigin, randomId, getStorage, isDetachedView,
        isClosedWindow, safeRead, waitForPeer, showDetachedError,
    });
})();
