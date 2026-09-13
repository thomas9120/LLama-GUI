// Shared JSON requests; loading this module has no side effects.
(() => {
    async function fetchJson(url, options) {
        const resp = await fetch(url, { cache: "no-store", ...(options || {}) });
        let data = null;
        try {
            data = await resp.json();
        } catch (e) {
            if (!resp.ok) {
                throw new Error(`Request failed (${resp.status})`);
            }
            throw new Error(`Invalid JSON response from ${url}`);
        }

        if (!resp.ok) {
            const message = data && data.error ? data.error : `Request failed (${resp.status})`;
            throw new Error(message);
        }

        return data;
    }

    window.LlamaGui = window.LlamaGui || {};
    window.LlamaGui.apiClient = { fetchJson };
})();
