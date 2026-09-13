// Shared toast presentation; loading this module is inert.
(function () {
    "use strict";
    const root = window.LlamaGui = window.LlamaGui || {};

    const TOAST_MAX_VISIBLE = 5;
    const DEFAULT_TOAST_DURATION_MS = 4000;

    function dismissToast(toast) {
        if (!toast || toast.dataset.dismissing === "true") return;
        toast.dataset.dismissing = "true";
        const timerId = Number(toast.dataset.timerId || 0);
        if (timerId) {
            clearTimeout(timerId);
        }
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        toast.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        setTimeout(() => toast.remove(), 220);
    }

    function capToastStack(container) {
        const toasts = Array.from(container.querySelectorAll(".toast"));
        const overflow = toasts.length - TOAST_MAX_VISIBLE;
        if (overflow <= 0) return;
        for (const toast of toasts.slice(0, overflow)) {
            dismissToast(toast);
        }
    }

    function showToast(message, type, options = {}) {
        const container = document.getElementById("toast-container");
        if (!container) return;
        const duration = Object.prototype.hasOwnProperty.call(options, "duration")
            ? Number(options.duration)
            : DEFAULT_TOAST_DURATION_MS;
        const action = options.action;
        const toast = document.createElement("div");
        toast.className = "toast toast-" + (type || "info");
        toast.setAttribute("role", "status");
        const icon = document.createElement("span");
        icon.className = "icon icon-sm toast-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = '<svg viewBox="0 0 24 24">' +
            (type === "success" ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
                '<polyline points="22 4 12 14.01 9 11.01"/>' :
                type === "error" ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' :
                    type === "warning" ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' :
                        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>') +
            '</svg>';
        const text = document.createElement("span");
        text.className = "toast-message";
        text.textContent = String(message || "");
        const closeBtn = document.createElement("button");
        closeBtn.className = "toast-close";
        closeBtn.type = "button";
        closeBtn.title = "Dismiss";
        closeBtn.setAttribute("aria-label", "Dismiss notification");
        closeBtn.textContent = "×";
        closeBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            dismissToast(toast);
        });
        toast.addEventListener("click", () => dismissToast(toast));
        toast.appendChild(icon);
        toast.appendChild(text);
        if (action && typeof action.label === "string" && action.label
            && typeof action.onClick === "function") {
            const actionBtn = document.createElement("button");
            actionBtn.className = "toast-action";
            actionBtn.type = "button";
            // textContent only: toast content must never be HTML (XSS smoke test).
            actionBtn.textContent = action.label;
            actionBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                dismissToast(toast);
                action.onClick();
            });
            toast.appendChild(actionBtn);
        }
        toast.appendChild(closeBtn);
        container.appendChild(toast);
        capToastStack(container);
        if (Number.isFinite(duration) && duration > 0) {
            const timerId = setTimeout(() => dismissToast(toast), duration);
            toast.dataset.timerId = String(timerId);
        }
    }

    root.notifications = { showToast };
})();
