// Shared confirmation and prompt dialogs; loading this module has no side effects.
(() => {
    function confirmAction(title, message, confirmText) {
        const modal = document.getElementById("confirm-modal");
        const titleEl = document.getElementById("confirm-modal-title");
        const messageEl = document.getElementById("confirm-modal-message");
        const cancelBtn = document.getElementById("confirm-modal-cancel");
        const okBtn = document.getElementById("confirm-modal-ok");

        titleEl.textContent = title || "Confirm Action";
        messageEl.textContent = message || "Are you sure you want to continue?";
        okBtn.textContent = confirmText || "Confirm";

        modal.classList.remove("hidden");
        okBtn.focus();

        return new Promise((resolve) => {
            const cleanup = () => {
                modal.classList.add("hidden");
                cancelBtn.removeEventListener("click", onCancel);
                okBtn.removeEventListener("click", onConfirm);
                modal.removeEventListener("click", onBackdrop);
                document.removeEventListener("keydown", onKeydown);
            };

            const finish = (value) => {
                cleanup();
                resolve(value);
            };

            const onCancel = () => finish(false);
            const onConfirm = () => finish(true);
            const onBackdrop = (e) => {
                if (e.target === modal) finish(false);
            };
            const onKeydown = (e) => {
                if (e.key === "Escape") finish(false);
                if (e.key === "Enter") {
                    e.preventDefault();
                    finish(e.target !== cancelBtn);
                }
            };

            cancelBtn.addEventListener("click", onCancel);
            okBtn.addEventListener("click", onConfirm);
            modal.addEventListener("click", onBackdrop);
            document.addEventListener("keydown", onKeydown);
        });
    }

    function promptAction(title, message, defaultValue, confirmText) {
        const modal = document.getElementById("prompt-modal");
        const titleEl = document.getElementById("prompt-modal-title");
        const messageEl = document.getElementById("prompt-modal-message");
        const input = document.getElementById("prompt-modal-input");
        const cancelBtn = document.getElementById("prompt-modal-cancel");
        const okBtn = document.getElementById("prompt-modal-ok");

        titleEl.textContent = title || "Enter a Value";
        messageEl.textContent = message || "";
        okBtn.textContent = confirmText || "Confirm";
        input.value = defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);

        modal.classList.remove("hidden");
        input.focus();
        input.select();

        return new Promise((resolve) => {
            const cleanup = () => {
                modal.classList.add("hidden");
                cancelBtn.removeEventListener("click", onCancel);
                okBtn.removeEventListener("click", onConfirm);
                modal.removeEventListener("click", onBackdrop);
                document.removeEventListener("keydown", onKeydown);
            };

            const finish = (value) => {
                cleanup();
                resolve(value);
            };

            // resolves to null on cancel so callers can tell "dismissed" from "cleared the field"
            const onCancel = () => finish(null);
            const onConfirm = () => finish(input.value.trim());
            const onBackdrop = (e) => {
                if (e.target === modal) finish(null);
            };
            const onKeydown = (e) => {
                if (e.key === "Escape") finish(null);
                if (e.key === "Enter") {
                    e.preventDefault();
                    finish(input.value.trim());
                }
            };

            cancelBtn.addEventListener("click", onCancel);
            okBtn.addEventListener("click", onConfirm);
            modal.addEventListener("click", onBackdrop);
            document.addEventListener("keydown", onKeydown);
        });
    }

    window.LlamaGui = window.LlamaGui || {};
    window.LlamaGui.dialogs = { confirmAction, promptAction };
})();
