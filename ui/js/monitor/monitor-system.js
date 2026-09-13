// CPU, RAM, disk rendering and accepted telemetry presentation.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    function setMetricCard(prefix, available, percent, subText) {
        const valueEl = I.dom.byId(`monitor-${prefix}-value`);
        const subEl = I.dom.byId(`monitor-${prefix}-sub`);
        const barHolder = I.dom.byId(`monitor-${prefix}-bar`);
        if (valueEl) {
            if (available && I.dom.clampPercent(percent) !== null) {
                if (valueEl.childElementCount !== 2) {
                    valueEl.replaceChildren(
                        I.dom.makeEl("span", ""),
                        I.dom.makeEl("span", "monitor-metric-unit", "%"),
                    );
                }
                I.dom.setText(valueEl.children[0], I.dom.formatPercentValue(percent, 1));
            } else {
                I.dom.setText(valueEl, available ? "--" : "Not available");
            }
        }
        I.dom.setText(subEl, available ? (subText || "") : "Collector unavailable");
        if (barHolder) {
            let bar = barHolder.querySelector(".progress-bar");
            if (!bar) {
                bar = I.dom.makeProgressBar(`${prefix} usage`, null);
                barHolder.replaceChildren(bar);
            }
            I.dom.updateProgressBar(bar, available ? percent : null, `${prefix} usage`);
        }
    }

    function renderSystemMetrics(system) {
        const data = system || {};
        const cpu = data.cpu || {};
        const memory = data.memory || {};
        const disk = data.disk || {};

        const interval = I.polling.getSampleInterval();
        const sampleText = Number.isFinite(interval) && interval > 0
            ? `${interval.toFixed(1)} s sample`
            : "";
        const intervalText = sampleText ? ` \u00b7 ${sampleText}` : "";

        setMetricCard("cpu", cpu.available === true, cpu.percent,
            cpu.available === true && cpu.percent !== null && cpu.percent !== undefined
                ? sampleText
                : cpu.available === true ? `Waiting for first sample${intervalText}` : "");

        const memUsed = Number(memory.used_bytes);
        const memTotal = Number(memory.total_bytes);
        setMetricCard("memory", memory.available === true, memory.percent,
            memory.available === true && Number.isFinite(memUsed) && Number.isFinite(memTotal)
                ? `${I.dom.formatBytes(memUsed)} used of ${I.dom.formatBytes(memTotal)}`
                : memory.available === true ? "Waiting for first sample" : "");

        const readRate = I.dom.finiteNonNegativeOrNull(disk.read_bytes_per_second);
        const writeRate = I.dom.finiteNonNegativeOrNull(disk.write_bytes_per_second);
        const hasRates = readRate !== null || writeRate !== null;
        const waiting = !hasRates && disk.io_available === true;
        I.dom.setText(I.dom.byId("monitor-disk-read"), waiting ? "--" : I.dom.formatRate(readRate));
        I.dom.setText(I.dom.byId("monitor-disk-write"), waiting ? "--" : I.dom.formatRate(writeRate));
        const activity = !hasRates ? waiting ? "Collecting activity…" : "Disk activity unavailable"
            : readRate > 0 && writeRate > 0 ? "Reading and writing"
                : readRate > 0 ? "Reading" : writeRate > 0 ? "Writing"
                    : readRate === 0 && writeRate === 0 ? "Idle" : "Partial reading";
        I.dom.setText(I.dom.byId("monitor-disk-activity"), activity);
        const scope = String(disk.io_label || "").trim();
        I.dom.setText(I.dom.byId("monitor-disk-sub"), hasRates
            ? `${scope || "Disk I/O"}${intervalText} · Includes other applications`
            : waiting ? `${scope ? `${scope} · ` : ""}Waiting for two samples`
                : "The system collector could not provide disk I/O readings.");
    }

    function renderSample(sample) {
        if (!sample) return;
        if (I.preferences.deferSample(sample)) return;
        renderSystemMetrics(sample.system);
        I.gpu.renderGpuArea(sample);
    }

    I.system = {
        renderSample,
    };
})();
