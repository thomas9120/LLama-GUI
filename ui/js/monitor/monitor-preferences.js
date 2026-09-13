// Card visibility, persistence, keyboard/drag order, and deferred telemetry.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    const HIDDEN_STORAGE_KEY = "llama_gui_monitor_hidden_cards";
    const HIDDEN_MAX_ENTRIES = 100;
    const HIDDEN_MAX_KEY_LENGTH = 256;
    const HIDDEN_MAX_LABEL_LENGTH = 120;

    const ORDER_STORAGE_KEY = "llama_gui_monitor_card_order";
    const ORDER_MAX_ENTRIES = 100;
    const ORDER_MAX_KEY_LENGTH = 256;
    // Cards reorder within their own container flow only (metrics grid, GPU
    // grid, state cards, setup cards). TODO: upgrade path is a single
    // flattened grid if cross-container moves are ever wanted.
    const ORDER_CONTAINER_SELECTOR = ".monitor-drag-container";
    // Chromium suppresses clicks and text selection under a draggable
    // ancestor, so the dedicated grip is the only draggable element.
    const ORDER_DRAG_HANDLE_SELECTOR = ".monitor-drag-handle";

    // key -> { label, sessionOnly }
    let hiddenCards = new Map();
    let hiddenRestoreSignature = "";
    // Effective card order (keys may exist across all containers); session-only
    // index-fallback keys may ride along in memory but are never persisted.
    let cardOrder = [];
    let dragKey = null;
    let dragContainer = null;
    let dragActive = false;
    // A sample that landed mid-drag; the GPU rebuild would destroy the dragged
    // node and cancel the drag, so it is deferred until the drag ends.
    let deferredRender = null;

    function isSessionOnlyKey(key) {
        // Index-fallback GPU identities are not stable across boots, so their
        // hides last for the session only.
        return typeof key === "string" && key.startsWith("gpu:") && key.includes(":index:");
    }

    function normalizeHiddenEntries(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        const entries = [];
        for (const entry of value) {
            if (entries.length >= HIDDEN_MAX_ENTRIES) break;
            if (!entry || typeof entry !== "object") continue;
            const key = typeof entry.key === "string" ? entry.key : "";
            const label = typeof entry.label === "string" ? entry.label : "";
            if (!key || key.length > HIDDEN_MAX_KEY_LENGTH || seen.has(key)) continue;
            seen.add(key);
            entries.push({ key, label: label.slice(0, HIDDEN_MAX_LABEL_LENGTH) });
        }
        return entries;
    }

    function normalizeOrderEntries(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        const order = [];
        for (const key of value) {
            if (order.length >= ORDER_MAX_ENTRIES) break;
            if (typeof key !== "string" || !key || key.length > ORDER_MAX_KEY_LENGTH) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            order.push(key);
        }
        return order;
    }

    function makeHideButton(key, label) {
        const button = I.dom.makeEl("button", "btn btn-sm btn-ghost monitor-hide-btn", "Hide");
        button.type = "button";
        button.setAttribute("aria-label", `Hide ${label} monitor`);
        button.title = `Hide ${label}`;
        button.addEventListener("click", () => {
            // Resolve from the card at click time: in-place updates rewrite a
            // card's label (a GPU index or name) long after construction.
            const card = typeof button.closest === "function"
                ? button.closest("[data-monitor-key]")
                : null;
            hideCard(key, (card && card.dataset.monitorLabel) || label || key);
        });
        return button;
    }

    function makeDragHandle(label) {
        const button = I.dom.makeEl("button", "btn btn-sm btn-ghost monitor-drag-handle", "⠿");
        button.type = "button";
        button.draggable = true;
        button.title = "Drag to reorder; use arrow keys to move";
        button.setAttribute("aria-label", `Move ${label} monitor; use arrow keys`);
        return button;
    }

    function loadHiddenCards() {
        hiddenCards = new Map();
        try {
            const raw = localStorage.getItem(HIDDEN_STORAGE_KEY);
            if (!raw) return;
            for (const entry of normalizeHiddenEntries(JSON.parse(raw))) {
                hiddenCards.set(entry.key, { label: entry.label, sessionOnly: isSessionOnlyKey(entry.key) });
            }
        } catch (error) {
            console.debug("Could not read hidden monitor cards", error);
        }
    }

    function persistHiddenCards() {
        try {
            const entries = [];
            for (const [key, value] of hiddenCards) {
                if (value.sessionOnly) continue;
                entries.push({ key, label: value.label });
            }
            const retained = entries.slice(-HIDDEN_MAX_ENTRIES);
            localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(retained));
            if (entries.length > HIDDEN_MAX_ENTRIES) {
                const retainedKeys = new Set(retained.map(entry => entry.key));
                for (const [key, value] of hiddenCards) {
                    if (!value.sessionOnly && !retainedKeys.has(key)) hiddenCards.delete(key);
                }
            }
        } catch (error) {
            console.debug("Could not persist hidden monitor cards", error);
        }
    }

    function hiddenBarEls() {
        return {
            controls: I.dom.byId("monitor-hidden-controls"),
            count: I.dom.byId("monitor-hidden-count"),
            items: I.dom.byId("monitor-restore-items"),
        };
    }

    function applyHiddenCardsToDom() {
        const cards = Array.from(document.querySelectorAll("[data-monitor-key]"));
        const relevant = [];
        for (const card of cards) {
            const key = card.dataset.monitorKey;
            const hidden = hiddenCards.has(key);
            card.classList.toggle("hidden", hidden);
            if (hidden) relevant.push(card);
        }

        const { controls, count, items } = hiddenBarEls();
        if (!controls || !count || !items) return;
        controls.classList.toggle("hidden", relevant.length === 0);
        if (relevant.length === 0) controls.open = false;
        count.textContent = relevant.length === 1 ? "1 card hidden" : `${relevant.length} cards hidden`;

        const signature = relevant.map(card => `${card.dataset.monitorKey}\u0000${card.dataset.monitorLabel || ""}`).join("\u0001");
        if (signature === hiddenRestoreSignature) return;
        hiddenRestoreSignature = signature;
        items.replaceChildren();
        for (const card of relevant) {
            const key = card.dataset.monitorKey;
            const label = card.dataset.monitorLabel || key;
            const row = I.dom.makeEl("div", "monitor-restore-row");
            row.appendChild(I.dom.makeEl("span", "", label));
            const restore = I.dom.makeEl("button", "btn btn-sm btn-ghost", "Show");
            restore.type = "button";
            restore.setAttribute("aria-label", `Show ${label} monitor`);
            restore.addEventListener("click", () => restoreCard(key, card));
            row.appendChild(restore);
            items.appendChild(row);
        }
    }

    function hideCard(key, label) {
        if (!key) return;
        hiddenCards.delete(key);
        hiddenCards.set(key, { label: label || key, sessionOnly: isSessionOnlyKey(key) });
        persistHiddenCards();
        applyHiddenCardsToDom();
        // Hiding the focused card moves focus to the restore control.
        const { controls } = hiddenBarEls();
        if (controls) {
            const summary = controls.querySelector("summary");
            if (summary && typeof summary.focus === "function") summary.focus();
        }
    }

    function restoreCard(key, cardEl) {
        hiddenCards.delete(key);
        persistHiddenCards();
        applyHiddenCardsToDom();
        const card = cardEl || document.querySelector(`[data-monitor-key="${CSS.escape ? CSS.escape(key) : key}"]`);
        if (card) {
            const disclosure = card.closest?.("#monitor-gpu-help");
            if (disclosure) disclosure.open = true;
            const target = card.querySelector(".card-title") || card.querySelector(".monitor-hide-btn") || card;
            if (target && typeof target.focus === "function") {
                if (!target.hasAttribute || !target.hasAttribute("tabindex")) {
                    if (typeof target.setAttribute === "function") target.setAttribute("tabindex", "-1");
                }
                target.focus();
            }
        }
    }

    function showAllCards() {
        const disclosure = I.dom.byId("monitor-gpu-help");
        if (disclosure?.querySelector(".card.hidden")) disclosure.open = true;
        hiddenCards = new Map();
        persistHiddenCards();
        applyHiddenCardsToDom();
    }

    function loadCardOrder() {
        cardOrder = [];
        try {
            const raw = localStorage.getItem(ORDER_STORAGE_KEY);
            if (raw) cardOrder = normalizeOrderEntries(JSON.parse(raw));
        } catch (error) {
            console.debug("Could not read monitor card order", error);
        }
    }

    function persistCardOrder() {
        try {
            // Index-fallback GPU keys are session-only, exactly like hides.
            const retained = normalizeOrderEntries(
                cardOrder.filter(key => !isSessionOnlyKey(key))
            );
            localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(retained));
        } catch (error) {
            console.debug("Could not persist monitor card order", error);
        }
    }

    function applyCardOrderToDom() {
        if (typeof document.querySelectorAll !== "function") return;
        for (const container of document.querySelectorAll(ORDER_CONTAINER_SELECTOR)) {
            if (!container || !container.children) continue;
            const cards = Array.from(container.children).filter(
                child => child && child.dataset && child.dataset.monitorKey
            );
            if (cards.length < 2) continue;
            // Cards absent from the persisted order keep their current DOM
            // order after every known card.
            const currentIndex = new Map();
            cards.forEach((card, index) => currentIndex.set(card.dataset.monitorKey, index));
            const orderOf = (card) => {
                const known = cardOrder.indexOf(card.dataset.monitorKey);
                return known !== -1 ? known : cardOrder.length + currentIndex.get(card.dataset.monitorKey);
            };
            const sorted = cards.slice().sort((a, b) => orderOf(a) - orderOf(b));
            // Re-appending a card removes and re-inserts it, which drops focus
            // and collapses a selection even though the node survives; only
            // touch the DOM when the order is actually wrong.
            let inOrder = true;
            for (let i = 0; i < sorted.length; i += 1) {
                if (sorted[i] !== cards[i]) { inOrder = false; break; }
            }
            if (inOrder) continue;
            for (const card of sorted) container.appendChild(card);
        }
    }

    function monitorCardFromEvent(event) {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function") return null;
        return target.closest("[data-monitor-key]");
    }

    function clearDropMarkers() {
        if (typeof document.querySelectorAll !== "function") return;
        for (const card of document.querySelectorAll("[data-monitor-key]")) {
            card.classList.remove("drop-before", "drop-after", "drop-horizontal");
        }
    }

    function updateCardOrder(containerKeys) {
        const other = cardOrder.filter(key => !containerKeys.includes(key));
        cardOrder = other.concat(containerKeys);
        persistCardOrder();
        applyCardOrderToDom();
    }

    function dropPlacement(container, dropCard, clientX, clientY) {
        const rect = typeof dropCard.getBoundingClientRect === "function"
            ? dropCard.getBoundingClientRect()
            : null;
        if (!rect) return { before: false, horizontal: false };
        const horizontal = Array.from(container.children).some((other) => {
            if (other === dropCard || (other.classList && other.classList.contains("hidden"))
                    || typeof other.getBoundingClientRect !== "function") return false;
            const otherRect = other.getBoundingClientRect();
            return rect.width > 0 && otherRect.width > 0
                && Math.max(rect.top, otherRect.top) < Math.min(rect.bottom, otherRect.bottom);
        });
        const point = Number(horizontal ? clientX : clientY);
        const midpoint = horizontal
            ? rect.left + rect.width / 2
            : rect.top + rect.height / 2;
        return {
            before: Number.isFinite(point) ? point < midpoint : false,
            horizontal,
        };
    }

    function reorderCard(container, draggedKey, dropCard, clientX, clientY) {
        const keys = Array.from(container.children)
            .filter(child => child && child.dataset && child.dataset.monitorKey)
            .map(child => child.dataset.monitorKey);
        const remaining = keys.filter(key => key !== draggedKey);
        if (remaining.length === keys.length) return;
        let insertAt;
        if (dropCard) {
            const index = remaining.indexOf(dropCard.dataset.monitorKey);
            if (index === -1) return;
            const { before } = dropPlacement(container, dropCard, clientX, clientY);
            insertAt = before ? index : index + 1;
        } else {
            // Dropped on empty container space: append at the end.
            insertAt = remaining.length;
        }
        remaining.splice(insertAt, 0, draggedKey);
        updateCardOrder(remaining);
    }

    function onKeyDown(container, event) {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function"
                || !target.closest(ORDER_DRAG_HANDLE_SELECTOR)) return;
        const offset = event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
        if (!offset) return;
        event.preventDefault();
        const card = monitorCardFromEvent(event);
        const cards = Array.from(container.children).filter(
            child => child && child.dataset && child.dataset.monitorKey
                && !(child.classList && child.classList.contains("hidden"))
        );
        const index = cards.indexOf(card);
        const targetCard = cards[index + offset];
        if (index === -1 || !targetCard) return;
        const keys = Array.from(container.children)
            .filter(child => child && child.dataset && child.dataset.monitorKey)
            .map(child => child.dataset.monitorKey)
            .filter(key => key !== card.dataset.monitorKey);
        const targetIndex = keys.indexOf(targetCard.dataset.monitorKey);
        keys.splice(offset < 0 ? targetIndex : targetIndex + 1, 0, card.dataset.monitorKey);
        updateCardOrder(keys);
        if (typeof target.focus === "function") target.focus();
    }

    function onDragStart(container, event) {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function"
                || !target.closest(ORDER_DRAG_HANDLE_SELECTOR)) return;
        const card = monitorCardFromEvent(event);
        if (!card) return;
        dragKey = card.dataset.monitorKey;
        dragContainer = container;
        dragActive = true;
        card.classList.add("dragging");
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            try {
                event.dataTransfer.setData("text/plain", dragKey);
            } catch (error) {
                console.debug("Could not set drag payload", error);
            }
        }
    }

    function onDragOver(container, event) {
        if (!dragActive || !dragKey) return;
        if (dragContainer !== container) {
            clearDropMarkers();
            return;
        }
        const card = monitorCardFromEvent(event);
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        clearDropMarkers();
        if (card && card.dataset.monitorKey !== dragKey) {
            event.preventDefault();
            const { before, horizontal } = dropPlacement(
                container, card, event.clientX, event.clientY
            );
            card.classList.toggle("drop-horizontal", horizontal);
            card.classList.add(before ? "drop-before" : "drop-after");
        } else if (!card) {
            event.preventDefault();
            // Empty container space appends at the end: mark the last card.
            const cards = Array.from(container.children).filter(
                child => child && child.dataset && child.dataset.monitorKey
            );
            const last = cards[cards.length - 1];
            if (last) last.classList.add("drop-after");
        }
    }

    function onDrop(container, event) {
        if (!dragActive || !dragKey || dragContainer !== container) return;
        event.preventDefault();
        reorderCard(
            container, dragKey, monitorCardFromEvent(event), event.clientX, event.clientY
        );
        finishDrag();
    }

    function finishDrag() {
        if (!dragActive) return;
        dragKey = null;
        dragContainer = null;
        dragActive = false;
        if (typeof document.querySelectorAll === "function") {
            for (const card of document.querySelectorAll("[data-monitor-key]")) {
                card.classList.remove("dragging", "drop-before", "drop-after", "drop-horizontal");
            }
        }
        if (deferredRender !== null) {
            const sample = deferredRender;
            deferredRender = null;
            I.system.renderSample(sample);
        }
    }

    // Keep the newest sample until the dragged node can safely be reconciled.
    function deferSample(sample) {
        if (!dragActive) return false;
        deferredRender = sample;
        return true;
    }

    function reset() {
        hiddenCards = new Map();
        hiddenRestoreSignature = "";
        cardOrder = [];
        dragKey = null;
        dragContainer = null;
        dragActive = false;
        deferredRender = null;
    }
    function bindControls() {
        const showAllBtn = I.dom.byId("btn-monitor-show-all");
        if (showAllBtn) showAllBtn.addEventListener("click", showAllCards);

        // Static cards (system/inference) declare their hide buttons inline.
        const staticHideButtons = document.querySelectorAll
            ? document.querySelectorAll("[data-monitor-hide]")
            : [];
        for (const button of staticHideButtons) {
            button.addEventListener("click", () => {
                const key = button.dataset.monitorHide;
                const card = typeof button.closest === "function"
                    ? button.closest("[data-monitor-key]")
                    : null;
                const label = (card && card.dataset.monitorLabel) || key;
                hideCard(key, label);
            });
        }

        // Drag-and-drop reordering, delegated per container so per-sample card
        // rebuilds need no re-binding. Cards move within their own container
        // only (see ORDER_CONTAINER_SELECTOR).
        if (typeof document.querySelectorAll === "function") {
            for (const container of document.querySelectorAll(ORDER_CONTAINER_SELECTOR)) {
                container.addEventListener("keydown", (event) => onKeyDown(container, event));
                container.addEventListener("dragstart", (event) => onDragStart(container, event));
                container.addEventListener("dragover", (event) => onDragOver(container, event));
                container.addEventListener("drop", (event) => onDrop(container, event));
                container.addEventListener("dragend", () => finishDrag());
            }
        }

    }

    I.preferences = {
        bindControls,
        applyCardOrderToDom,
        applyHiddenCardsToDom,
        deferSample,
        isSessionOnlyKey,
        loadCardOrder,
        loadHiddenCards,
        makeDragHandle,
        makeHideButton,
        normalizeHiddenEntries,
        normalizeOrderEntries,
        reset,
    };
})();
