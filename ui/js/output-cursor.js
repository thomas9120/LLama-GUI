(function () {
    const root = window.LlamaGui = window.LlamaGui || {};

    function create(onLine) {
        let cursor = null;
        let epoch = 0;

        function reset(nextCursor = null) {
            cursor = Number.isSafeInteger(nextCursor) && nextCursor >= 0 ? nextCursor : null;
            epoch += 1;
        }

        // Reject in-flight responses without discarding the cursor. Clearing
        // the terminal uses this so the backlog does not replay; a reset()
        // to a null cursor would make the next request replay everything.
        function invalidate() {
            epoch += 1;
        }

        function getUrl() {
            return cursor === null ? "/api/output" : `/api/output?since=${cursor}`;
        }

        function getRequest() {
            return { url: getUrl(), epoch };
        }

        function isCurrent(requestEpoch) {
            return requestEpoch === epoch;
        }

        function consume(data, requestEpoch = epoch) {
            if (requestEpoch !== epoch) return { current: false, lines: [] };
            const lines = data && Array.isArray(data.lines) ? data.lines : [];
            const nextCursor = data && Number.isSafeInteger(data.next_cursor) && data.next_cursor >= 0
                ? data.next_cursor
                : null;
            if (cursor !== null && nextCursor !== null && nextCursor <= cursor) {
                return { current: true, lines: [] };
            }
            if (data && data.dropped) onLine("--- Earlier process output was truncated ---");
            for (const line of lines) onLine(line);
            if (nextCursor !== null) cursor = nextCursor;
            return { current: true, lines };
        }

        return { reset, invalidate, getUrl, getRequest, isCurrent, consume };
    }

    root.outputCursor = { create };
})();
