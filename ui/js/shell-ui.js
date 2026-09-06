(function () {
    window.LlamaGui = window.LlamaGui || {};
    let dependencies = {};
    let mobileQuery = null;

    function setNavigationOpen(open, returnFocus = false) {
        const sidebar = document.getElementById("sidebar");
        if (!sidebar || !mobileQuery) return;
        open = Boolean(open && mobileQuery.matches);
        const toggle = document.getElementById("mobile-toggle");
        sidebar.classList.toggle("open", open);
        sidebar.inert = mobileQuery.matches && !open;
        document.querySelector(".main-content").inert = open;
        document.getElementById("sidebar-backdrop").hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        if (open) document.getElementById("sidebar-close").focus();
        else if (returnFocus) toggle.focus();
    }

    function onTabChanged(tabId) {
        document.querySelectorAll(".nav-item").forEach(item => {
            const selected = item.dataset.section === tabId;
            item.classList.toggle("active", selected);
            if (selected) item.setAttribute("aria-current", "page");
            else item.removeAttribute("aria-current");
        });
        const wasOpen = document.getElementById("sidebar")?.classList.contains("open");
        setNavigationOpen(false);
        if (wasOpen) {
            const heading = document.querySelector(`#section-${tabId} .page-title`);
            if (heading) {
                heading.setAttribute("tabindex", "-1");
                heading.focus({ preventScroll: true });
            }
        }
    }

    function init(options) {
        dependencies = options;
        mobileQuery = window.matchMedia("(max-width: 900px)");
        document.querySelectorAll(".nav-item").forEach(item => {
            item.addEventListener("click", () => dependencies.switchTab(item.dataset.section));
        });
        document.getElementById("mobile-toggle").addEventListener("click", () => setNavigationOpen(true));
        document.getElementById("sidebar-close").addEventListener("click", () => setNavigationOpen(false, true));
        document.getElementById("sidebar-backdrop").addEventListener("click", () => setNavigationOpen(false, true));
        mobileQuery.addEventListener("change", () => setNavigationOpen(false));
        document.getElementById("sidebar").addEventListener("keydown", event => {
            if (!mobileQuery.matches || !document.getElementById("sidebar").classList.contains("open")) return;
            if (event.key === "Escape") {
                // Let nested menus close themselves first.
                if (event.defaultPrevented) return;
                event.preventDefault();
                setNavigationOpen(false, true);
            } else if (event.key === "Tab") {
                const controls = [...document.querySelectorAll('#sidebar button, #sidebar summary, #sidebar [tabindex="0"]')]
                    .filter(el => !el.disabled && el.getClientRects().length);
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        document.getElementById("btn-sidebar-runtime-details").addEventListener("click", () => {
            const state = dependencies.getLifecycleSnapshot();
            const external = !state.activeRuntime && state.phase === "idle" && dependencies.getLatestStatus()?.external_chat_target?.connected;
            dependencies.switchTab(external ? "api" : "monitor");
        });
        setNavigationOpen(false);
        renderRuntime();
    }

    function renderRuntime() {
        if (!dependencies.getLifecycleSnapshot) return;
        const state = dependencies.getLifecycleSnapshot();
        const runtime = state.activeRuntime;
        const target = dependencies.getLatestStatus()?.external_chat_target;
        const external = !runtime && state.phase === "idle" && target?.connected;
        const phase = external ? "external" : state.phase;
        const labels = { idle: "Stopped", starting: "Starting", loading: "Loading model", ready: "Ready", running: "Running", stopping: "Stopping", failed: "Action failed", external: "External server" };
        const status = document.getElementById("sidebar-runtime-state");
        const label = labels[phase] || "Checking…";
        if (status.textContent !== label) status.textContent = label;
        status.dataset.phase = phase;
        const model = document.getElementById("sidebar-runtime-model");
        const fullModel = runtime ? String(runtime.alias || runtime.model || "Model unavailable") : external ? String(target.label || "Managed outside this app") : "No local process running";
        model.textContent = runtime && !runtime.alias ? fullModel.split(/[\\/]/).pop() : fullModel;
        model.title = fullModel;
        document.getElementById("sidebar-runtime-build").textContent = runtime
            ? `${runtime.tool} · ${[runtime.backend, runtime.version].filter(Boolean).join(" · ") || "Build unavailable"}`
            : external ? "Managed outside Llama GUI" : "Launch from Quick Launch or Configure.";
        const endpoint = runtime?.tool === "llama-server" ? runtime : external ? target : null;
        document.getElementById("sidebar-runtime-endpoint").textContent = endpoint?.host && endpoint?.port
            ? `Endpoint: ${endpoint.host}:${endpoint.port}` : "";
        document.getElementById("btn-sidebar-runtime-details").textContent = external ? "Open API" : "Open Monitor";
    }

    window.LlamaGui.shellUi = { init, onTabChanged, renderRuntime };
})();
