(function () {
    "use strict";

    const THEME_STORAGE_KEY = "llama_gui_theme";
    // The pre-paint script in index.html cannot see THEMES (it must stay inline
    // and blocking, and duplicating the registry there would be a second source
    // of truth that silently rots). It reads the resolved scheme from here
    // instead, so a stored light theme no longer flashes the dark default while
    // theme-ui.js loads.
    const THEME_SCHEME_STORAGE_KEY = "llama_gui_theme_scheme";

    /**
     * Single source of truth for every theme the GUI ships. Adding a theme is
     * one entry here plus one token block in ui/css/tokens.css — nothing else.
     *
     * scheme drives the color-scheme hint, so it must match the token block's
     * own `color-scheme` declaration. Getting it wrong makes the browser style
     * native controls, scrollbars and form widgets for the opposite polarity.
     */
    const THEMES = [
        { id: "tokyo", label: "Tokyo", hint: "Dark", scheme: "dark", swatchBg: "#161824", swatchAccent: "#6c9bff" },
        { id: "nebula", label: "Nebula", hint: "Dark", scheme: "dark", swatchBg: "#121420", swatchAccent: "#8b5cf6" },
        { id: "graphite", label: "Graphite", hint: "Mid", scheme: "dark", swatchBg: "#383b41", swatchAccent: "#d9a05b" },
        { id: "cappuccino", label: "Cappuccino", hint: "Light", scheme: "light", swatchBg: "#fff4e6", swatchAccent: "#4b3832" },
        { id: "mint", label: "Mint", hint: "Light", scheme: "light", swatchBg: "#e3f0e9", swatchAccent: "#276947" },
    ];

    const DEFAULT_THEME = THEMES[0].id;
    const THEMES_BY_ID = new Map(THEMES.map(theme => [theme.id, theme]));

    function normalizeTheme(theme) {
        return THEMES_BY_ID.has(theme) ? theme : DEFAULT_THEME;
    }

    function getThemes() {
        return THEMES.map(theme => Object.assign({}, theme));
    }

    function getStoredTheme() {
        try {
            return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
        } catch (e) {
            console.debug("Failed to read theme preference", e);
            return DEFAULT_THEME;
        }
    }

    function colorSchemeContent(scheme) {
        return scheme === "light" ? "light dark" : "dark light";
    }

    function updateColorScheme(theme) {
        const scheme = THEMES_BY_ID.get(normalizeTheme(theme)).scheme;
        // Mirrored to storage on every apply so the pre-paint script has it on the
        // next load, including when the theme was changed in another tab.
        try {
            localStorage.setItem(THEME_SCHEME_STORAGE_KEY, scheme);
        } catch (e) {
            console.debug("Failed to save theme color-scheme hint", e);
        }
        const meta = document.querySelector('meta[name="color-scheme"]');
        if (!meta) return;
        meta.setAttribute("content", colorSchemeContent(scheme));
    }

    function applyTheme(theme, options = {}) {
        const nextTheme = normalizeTheme(theme);
        // Always set the attribute, including for the default theme, so every
        // theme is selected the same way and none is "the absent case".
        document.documentElement.dataset.theme = nextTheme;
        updateColorScheme(nextTheme);

        if (options.persist) {
            try {
                localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
            } catch (e) {
                console.warn("Failed to save theme preference", e);
            }
        }

        refreshSwitcher(nextTheme);
        return nextTheme;
    }

    function refreshSwitcher(activeTheme = getCurrentTheme()) {
        document.querySelectorAll("[data-theme-option]").forEach(button => {
            const isActive = normalizeTheme(button.dataset.themeOption) === activeTheme;
            button.classList.toggle("active", isActive);
            // menuitemradio takes aria-checked; aria-pressed is for toggle
            // buttons and would be ignored by assistive tech here.
            button.setAttribute("aria-checked", String(isActive));
            button.tabIndex = isActive ? 0 : -1;
        });

        const active = THEMES_BY_ID.get(activeTheme);
        const label = document.getElementById("theme-menu-current");
        if (label && active) label.textContent = active.label;
        const swatch = document.getElementById("theme-menu-current-swatch");
        if (swatch && active) swatch.style.background = swatchGradient(active);
    }

    function getCurrentTheme() {
        return normalizeTheme(document.documentElement.dataset.theme || DEFAULT_THEME);
    }

    function swatchGradient(theme) {
        return `linear-gradient(135deg, ${theme.swatchBg} 55%, ${theme.swatchAccent} 45%)`;
    }

    const CHECK_ICON = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

    /**
     * Builds the menu rows from THEMES. No-op when the list element is absent,
     * so the module stays usable on pages without the sidebar menu.
     */
    function renderMenu() {
        const list = document.getElementById("theme-menu-list");
        if (!list) return [];

        list.textContent = "";
        for (const theme of THEMES) {
            const item = document.createElement("li");
            // <li> inside role="menu" must not expose itself as a listitem.
            item.setAttribute("role", "none");

            const button = document.createElement("button");
            button.type = "button";
            button.className = "theme-menu-item";
            button.setAttribute("role", "menuitemradio");
            button.setAttribute("aria-checked", "false");
            button.dataset.themeOption = theme.id;
            button.tabIndex = -1;

            const swatch = document.createElement("span");
            swatch.className = "theme-menu-swatch";
            swatch.setAttribute("aria-hidden", "true");
            swatch.style.background = swatchGradient(theme);

            const label = document.createElement("span");
            label.className = "theme-menu-label";
            label.textContent = theme.label;

            const hint = document.createElement("span");
            hint.className = "theme-menu-hint";
            hint.textContent = theme.hint;

            const check = document.createElement("span");
            check.className = "icon icon-sm theme-menu-check";
            check.setAttribute("aria-hidden", "true");
            check.innerHTML = CHECK_ICON;

            button.appendChild(swatch);
            button.appendChild(label);
            button.appendChild(hint);
            button.appendChild(check);
            item.appendChild(button);
            list.appendChild(item);
        }
        return Array.from(list.querySelectorAll("[data-theme-option]"));
    }

    function initMenu(items) {
        const trigger = document.getElementById("theme-menu-trigger");
        const list = document.getElementById("theme-menu-list");
        if (!trigger || !list) return;

        const isOpen = () => trigger.getAttribute("aria-expanded") === "true";

        function setOpen(open, { focusItem = true } = {}) {
            list.hidden = !open;
            trigger.setAttribute("aria-expanded", String(open));
            if (open && focusItem) {
                const checked = items.find(item => item.getAttribute("aria-checked") === "true");
                (checked || items[0]).focus();
            }
        }

        function moveFocus(from, delta) {
            if (!items.length) return;
            const index = items.indexOf(from);
            // Wraps, so Up from the first row reaches the last without a
            // full traversal — the menu is short but this is what a menu
            // is expected to do.
            const next = (index + delta + items.length) % items.length;
            items[next].focus();
        }

        trigger.addEventListener("click", () => setOpen(!isOpen()));

        trigger.addEventListener("keydown", event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!isOpen()) setOpen(true);
                else items[event.key === "ArrowDown" ? 0 : items.length - 1].focus();
            }
        });

        for (const item of items) {
            item.addEventListener("click", () => {
                applyTheme(item.dataset.themeOption, { persist: true });
                setOpen(false, { focusItem: false });
                trigger.focus();
            });

            item.addEventListener("keydown", event => {
                switch (event.key) {
                    case "ArrowDown":
                        event.preventDefault();
                        moveFocus(item, 1);
                        break;
                    case "ArrowUp":
                        event.preventDefault();
                        moveFocus(item, -1);
                        break;
                    case "Home":
                        event.preventDefault();
                        items[0].focus();
                        break;
                    case "End":
                        event.preventDefault();
                        items[items.length - 1].focus();
                        break;
                    case "Escape":
                        event.preventDefault();
                        setOpen(false, { focusItem: false });
                        trigger.focus();
                        break;
                    case "Tab":
                        // Let focus leave naturally, but don't strand an open
                        // menu behind it.
                        setOpen(false, { focusItem: false });
                        break;
                    default:
                        break;
                }
            });
        }

        document.addEventListener("click", event => {
            if (!isOpen()) return;
            const target = event.target;
            if (target && typeof target.closest === "function" && target.closest(".theme-menu")) return;
            setOpen(false, { focusItem: false });
        });
    }

    function init() {
        const rendered = renderMenu();
        applyTheme(getStoredTheme());

        // Covers both the rendered menu rows and any [data-theme-option]
        // control supplied directly in markup.
        document.querySelectorAll("[data-theme-option]").forEach(button => {
            if (rendered.includes(button)) return;
            button.addEventListener("click", () => {
                applyTheme(button.dataset.themeOption, { persist: true });
            });
        });

        initMenu(rendered);
        refreshSwitcher();
    }

    window.LlamaGui = window.LlamaGui || {};
    window.LlamaGui.themeUi = {
        applyTheme,
        getCurrentTheme,
        getThemes,
        init,
        storageKey: THEME_STORAGE_KEY,
    };
})();
