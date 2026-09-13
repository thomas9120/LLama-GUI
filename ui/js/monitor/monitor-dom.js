// Shared Monitor formatting and DOM primitives.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

    function finiteOrNull(value) {
        if (value === null || value === undefined) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function finiteNonNegativeOrNull(value) {
        const num = finiteOrNull(value);
        return num !== null && num >= 0 ? num : null;
    }

    function clampPercent(value) {
        const num = finiteOrNull(value);
        if (num === null) return null;
        return Math.max(0, Math.min(100, num));
    }

    function formatBytes(bytes) {
        const value = finiteNonNegativeOrNull(bytes);
        if (value === null) return "Not available";
        let scaled = value;
        let unitIndex = 0;
        while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
            scaled /= 1024;
            unitIndex += 1;
        }
        const digits = unitIndex === 0 ? 0 : (scaled >= 100 ? 0 : 1);
        return `${scaled.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
    }

    function formatRate(bytesPerSecond) {
        const value = finiteNonNegativeOrNull(bytesPerSecond);
        if (value === null) return "Not available";
        return `${formatBytes(value)}/s`;
    }

    function formatPercentValue(value, digits = 0) {
        const clamped = clampPercent(value);
        if (clamped === null) return "Not available";
        return clamped.toFixed(digits);
    }

    function formatTokens(value) {
        const num = finiteNonNegativeOrNull(value);
        if (num === null) return "--";
        return Math.round(num).toLocaleString();
    }

    function formatSpeed(tokensPerSecond) {
        const num = finiteNonNegativeOrNull(tokensPerSecond);
        if (num === null) return "--";
        return num.toFixed(1);
    }

    function formatClock(epochSeconds) {
        const num = finiteOrNull(epochSeconds);
        if (num === null) return "--:--:--";
        const date = new Date(num * 1000);
        const pad = (part) => String(part).padStart(2, "0");
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function shortGpuId(id) {
        const text = String(id || "");
        if (text.length <= 24) return text;
        return `${text.slice(0, 12)}\u2026${text.slice(-5)}`;
    }

    function byId(id) {
        return document.getElementById(id);
    }

    function makeEl(tagName, className, text) {
        const el = document.createElement(tagName);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function setText(el, text) {
        const value = text === null || text === undefined ? "" : String(text);
        // Writing only on change keeps a value the user is selecting intact:
        // replacing the text node collapses their selection on every poll.
        if (el && el.textContent !== value) el.textContent = value;
    }

    function makeProgressBar(label, percent) {
        const bar = makeEl("div", "progress-bar");
        bar.setAttribute("role", "meter");
        bar.setAttribute("aria-label", label);
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.appendChild(makeEl("div", "progress-fill"));
        updateProgressBar(bar, percent, label);
        return bar;
    }

    function updateProgressBar(bar, percent, label) {
        if (!bar) return;
        if (label !== undefined) bar.setAttribute("aria-label", label);
        const clamped = clampPercent(percent);
        const fill = bar.querySelector(".progress-fill");
        if (fill) {
            const width = clamped === null ? "0%" : `${clamped}%`;
            if (fill.style.width !== width) fill.style.width = width;
        }
        // Unavailable meters keep their node (so focus and selection survive)
        // but render as an empty, hidden track rather than a fake zero.
        bar.classList.toggle("hidden", clamped === null);
        if (clamped === null) {
            bar.removeAttribute("aria-valuenow");
            bar.setAttribute("aria-valuetext", "Not available");
        } else {
            const now = String(Math.round(clamped * 10) / 10);
            if (bar.getAttribute("aria-valuenow") !== now) bar.setAttribute("aria-valuenow", now);
            bar.removeAttribute("aria-valuetext");
        }
    }

    function makeMetricRow(labelText, metricName) {
        const row = makeEl("div", "monitor-metric-row");
        if (metricName) row.dataset.metric = metricName;
        row.appendChild(makeEl("span", "monitor-metric-label", labelText));
        row.appendChild(makeEl("span", "monitor-metric-reading", ""));
        return row;
    }

    function metricRow(card, metricName) {
        return card && card.querySelector
            ? card.querySelector(`.monitor-metric-row[data-metric="${metricName}"]`)
            : null;
    }

    function updateMetricRow(row, readingText, unavailable) {
        if (!row) return;
        const reading = row.querySelector(".monitor-metric-reading");
        if (!reading) return;
        setText(reading, unavailable ? "Not available" : readingText);
        reading.classList.toggle("monitor-not-available", Boolean(unavailable));
    }

    I.dom = {
        byId,
        clampPercent,
        finiteNonNegativeOrNull,
        formatBytes,
        formatClock,
        formatPercentValue,
        formatRate,
        formatSpeed,
        formatTokens,
        makeEl,
        makeMetricRow,
        makeProgressBar,
        metricRow,
        setText,
        shortGpuId,
        updateMetricRow,
        updateProgressBar,
    };
})();
