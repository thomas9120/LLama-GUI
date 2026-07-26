/* Searchable combobox wrapper for native <select> elements.
 *
 * The native select stays in the DOM as the single source of truth:
 * population, value, and change events are untouched. The wrapper is a
 * pure view — picking an item sets select.value and dispatches a real
 * change event so existing sync/mirroring logic fires as before.
 */
(function () {
    const root = (window.LlamaGui = window.LlamaGui || {});
    let generatedId = 0;

    function getLabelledByText(select) {
        const ids = String(select.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .filter(Boolean);
        return ids
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((element) => String(element.textContent || "").trim())
            .filter(Boolean)
            .join(" ");
    }

    function getAccessibleLabel(select, labels, options) {
        const explicitLabel = String(select.getAttribute("aria-label") || "").trim();
        if (explicitLabel) return explicitLabel;

        const labelledByText = getLabelledByText(select);
        if (labelledByText) return labelledByText;

        const labelText = labels
            .map((label) => String(label.textContent || "").trim())
            .filter(Boolean)
            .join(" ");
        return labelText || String(options.accessibleLabel || "").trim();
    }

    function enhanceSelect(select, options = {}) {
        if (!select || select.dataset.ssEnhanced) return null;
        select.dataset.ssEnhanced = "true";

        const searchPlaceholder = options.searchPlaceholder || "Search...";
        const associatedLabels = Array.from(select.labels || []);
        const accessibleLabel = getAccessibleLabel(select, associatedLabels, options);
        const controlId = select.id || `ss-control-${++generatedId}`;

        select.classList.add("ss-native");
        select.tabIndex = -1;
        select.setAttribute("aria-hidden", "true");

        const wrap = document.createElement("div");
        wrap.className = "ss-wrap";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "ss-button";
        button.id = `${controlId}-ss-button`;
        button.setAttribute("aria-haspopup", "listbox");
        button.setAttribute("aria-expanded", "false");

        const buttonLabel = document.createElement("span");
        buttonLabel.className = "ss-button-label";
        const buttonArrow = document.createElement("span");
        buttonArrow.className = "ss-button-arrow";
        buttonArrow.textContent = "▾";
        button.append(buttonLabel, buttonArrow);

        const popup = document.createElement("div");
        popup.className = "ss-popup hidden";

        const search = document.createElement("input");
        search.type = "text";
        search.className = "ss-search";
        search.placeholder = searchPlaceholder;
        search.autocomplete = "off";
        search.spellcheck = false;
        search.setAttribute("role", "combobox");
        search.setAttribute("aria-autocomplete", "list");
        search.setAttribute("aria-expanded", "false");
        search.setAttribute("aria-label", accessibleLabel ? `Search ${accessibleLabel}` : "Search options");

        const list = document.createElement("div");
        list.className = "ss-list";
        list.id = `${controlId}-ss-list`;
        list.setAttribute("role", "listbox");
        if (accessibleLabel) list.setAttribute("aria-label", `${accessibleLabel} options`);
        button.setAttribute("aria-controls", list.id);
        search.setAttribute("aria-controls", list.id);

        popup.append(search, list);
        wrap.append(button, popup);
        select.insertAdjacentElement("afterend", wrap);
        for (const label of associatedLabels) {
            if (select.id && label.htmlFor === select.id) label.htmlFor = button.id;
        }

        let activeItems = [];
        let activeIndex = -1;
        let itemIndex = 0;

        function isOpen() {
            return !popup.classList.contains("hidden");
        }

        function updateButtonLabel() {
            const selected = select.selectedOptions && select.selectedOptions[0];
            const label = selected ? selected.textContent : "";
            const displayLabel = label || (options.placeholder || "Select...");
            buttonLabel.textContent = displayLabel;
            buttonLabel.classList.toggle("ss-placeholder", !selected || !selected.value);
            button.disabled = select.disabled;
            button.setAttribute("aria-label", accessibleLabel ? `${accessibleLabel}: ${displayLabel}` : displayLabel);
        }

        function optionMatches(option, query) {
            if (!query) return true;
            return option.textContent.toLowerCase().includes(query);
        }

        function choose(option) {
            if (!option || option.disabled) return;
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            close();
            button.focus();
        }

        function setActive(index) {
            activeIndex = index;
            activeItems.forEach((entry, i) => {
                entry.el.classList.toggle("is-active", i === activeIndex);
            });
            const active = activeItems[activeIndex];
            if (active) {
                search.setAttribute("aria-activedescendant", active.el.id);
                active.el.scrollIntoView({ block: "nearest" });
            } else {
                search.removeAttribute("aria-activedescendant");
            }
        }

        function appendItem(option) {
            const item = document.createElement("div");
            item.className = "ss-item";
            item.id = `${list.id}-option-${itemIndex++}`;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(option.value === select.value));
            item.setAttribute("aria-disabled", String(option.disabled));
            item.textContent = option.textContent;
            item.classList.toggle("is-selected", option.value === select.value);
            item.classList.toggle("is-disabled", option.disabled);
            if (!option.disabled) {
                item.addEventListener("click", () => choose(option));
                item.addEventListener("pointerenter", () => {
                    const idx = activeItems.findIndex((entry) => entry.el === item);
                    if (idx >= 0) setActive(idx);
                });
                activeItems.push({ el: item, option });
            }
            list.appendChild(item);
        }

        function renderList(query) {
            list.textContent = "";
            activeItems = [];
            activeIndex = -1;
            itemIndex = 0;
            search.removeAttribute("aria-activedescendant");
            let visibleCount = 0;

            for (const child of Array.from(select.children)) {
                if (child.tagName === "OPTGROUP") {
                    const matching = Array.from(child.children).filter((opt) => optionMatches(opt, query));
                    if (!matching.length) continue;
                    const group = document.createElement("div");
                    group.className = "ss-group";
                    group.textContent = child.label;
                    list.appendChild(group);
                    for (const opt of matching) {
                        appendItem(opt);
                        visibleCount += 1;
                    }
                } else if (child.tagName === "OPTION" && optionMatches(child, query)) {
                    appendItem(child);
                    visibleCount += 1;
                }
            }

            if (!visibleCount) {
                const empty = document.createElement("div");
                empty.className = "ss-empty";
                empty.textContent = "No matches.";
                list.appendChild(empty);
                return;
            }

            const selectedIdx = activeItems.findIndex((entry) => entry.option.value === select.value);
            setActive(selectedIdx >= 0 ? selectedIdx : 0);
        }

        function positionPopup() {
            const rect = button.getBoundingClientRect();
            popup.style.left = `${rect.left}px`;
            popup.style.width = `${rect.width}px`;
            popup.style.top = `${rect.bottom + 4}px`;
            const popHeight = popup.offsetHeight;
            if (rect.bottom + 4 + popHeight > window.innerHeight - 8 && rect.top - 4 - popHeight > 8) {
                popup.style.top = `${rect.top - 4 - popHeight}px`;
            }
        }

        function open() {
            if (select.disabled || isOpen()) return;
            // Escape overflow:hidden/animated ancestors (e.g. the model
            // switcher card) by rendering the popup against the viewport.
            if (popup.parentElement !== document.body) document.body.appendChild(popup);
            popup.classList.remove("hidden");
            button.setAttribute("aria-expanded", "true");
            search.setAttribute("aria-expanded", "true");
            search.value = "";
            renderList("");
            positionPopup();
            search.focus();
        }

        function close() {
            if (!isOpen()) return;
            popup.classList.add("hidden");
            button.setAttribute("aria-expanded", "false");
            search.setAttribute("aria-expanded", "false");
            search.removeAttribute("aria-activedescendant");
        }

        function moveActive(delta) {
            if (!activeItems.length) return;
            const next = (activeIndex + delta + activeItems.length) % activeItems.length;
            setActive(next);
        }

        button.addEventListener("click", () => (isOpen() ? close() : open()));
        button.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                open();
            }
        });

        search.addEventListener("input", () => {
            renderList(search.value.trim().toLowerCase());
            positionPopup();
        });
        search.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
            } else if (event.key === "Enter") {
                event.preventDefault();
                const active = activeItems[activeIndex];
                if (active) choose(active.option);
            } else if (event.key === "Escape") {
                event.preventDefault();
                close();
                button.focus();
            } else if (event.key === "Tab") {
                close();
            }
        });

        document.addEventListener("pointerdown", (event) => {
            if (!wrap.contains(event.target) && !popup.contains(event.target)) close();
        });

        document.addEventListener("scroll", (event) => {
            if (isOpen() && !popup.contains(event.target)) positionPopup();
        }, true);

        window.addEventListener("resize", () => {
            if (isOpen()) positionPopup();
        });

        select.addEventListener("change", updateButtonLabel);

        // Keep the view in sync with programmatic repopulation (refreshModels,
        // syncModelOptions, populateSlotSelect) and disabled-state changes.
        const observer = new MutationObserver(() => {
            updateButtonLabel();
            if (isOpen()) {
                renderList(search.value.trim().toLowerCase());
                positionPopup();
            }
        });
        observer.observe(select, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["disabled", "label"],
        });

        // Programmatic select.value = ... sets do not fire events; intercept
        // the value property on this element so the button label follows.
        const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
        if (valueDescriptor && valueDescriptor.get && valueDescriptor.set) {
            Object.defineProperty(select, "value", {
                configurable: true,
                enumerable: true,
                get() {
                    return valueDescriptor.get.call(this);
                },
                set(v) {
                    valueDescriptor.set.call(this, v);
                    updateButtonLabel();
                },
            });
        }

        updateButtonLabel();

        return {
            sync() {
                updateButtonLabel();
                if (isOpen()) renderList(search.value.trim().toLowerCase());
            },
        };
    }

    root.searchableSelect = Object.assign(root.searchableSelect || {}, {
        enhance: enhanceSelect,
    });
})();
