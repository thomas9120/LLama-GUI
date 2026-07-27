(function () {
    "use strict";

    const THEME_STORAGE_KEY = "llama_gui_theme";

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
        { id: "cappuccino", label: "Cappuccino", hint: "Light", scheme: "light", swatchBg: "#fff4e6", swatchAccent: "#4b3832" },
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

    function updateColorScheme(theme) {
        const meta = document.querySelector('meta[name="color-scheme"]');
        if (!meta) return;
        const scheme = THEMES_BY_ID.get(normalizeTheme(theme)).scheme;
        meta.setAttribute("content", scheme === "light" ? "light dark" : "dark light");
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
            button.setAttribute("aria-pressed", String(isActive));
        });
    }

    function getCurrentTheme() {
        return normalizeTheme(document.documentElement.dataset.theme || DEFAULT_THEME);
    }

    function init() {
        applyTheme(getStoredTheme());
        document.querySelectorAll("[data-theme-option]").forEach(button => {
            button.addEventListener("click", () => {
                applyTheme(button.dataset.themeOption, { persist: true });
            });
        });
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
