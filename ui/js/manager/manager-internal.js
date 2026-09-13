// Private package links. Domain state stays in each concern's closure.
// Read dependencies through I on each call so configure() updates remain live.
(() => {
    window.LlamaGui._managerInternal = {
        dependencies: { fetchJson: window.LlamaGui.apiClient.fetchJson },
    };
})();
