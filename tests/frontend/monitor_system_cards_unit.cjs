"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMonitorHarness } = require("./monitor_harness.cjs");

test("formatting", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi } = fixture;
assert.equal(monitorUi.formatBytes(0), "0 B");
assert.equal(monitorUi.formatBytes(1024), "1.0 KB");
assert.equal(monitorUi.formatBytes(512 * 1024 * 1024), "512 MB");
assert.equal(monitorUi.formatBytes(96.5 * 1024 * 1024), "96.5 MB");
assert.equal(monitorUi.formatBytes(48.0 * 1024 ** 3), "48.0 GB");
assert.equal(monitorUi.formatBytes(1.9 * 1024 ** 4), "1.9 TB");
assert.equal(monitorUi.formatBytes(null), "Not available");
assert.equal(monitorUi.formatBytes(-5), "Not available");
assert.equal(monitorUi.formatBytes("abc"), "Not available");

assert.equal(monitorUi.formatRate(1240000), "1.2 MB/s");
assert.equal(monitorUi.formatRate(null), "Not available");
assert.equal(monitorUi.formatRate(0), "0 B/s");

assert.equal(monitorUi.formatPercentValue(37.5, 1), "37.5");
assert.equal(monitorUi.formatPercentValue(150, 0), "100");
assert.equal(monitorUi.formatPercentValue(null), "Not available");
assert.equal(monitorUi.formatTokens(1536), "1,536");
assert.equal(monitorUi.formatTokens(null), "--");
assert.equal(monitorUi.formatClock(null), "--:--:--");
assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(monitorUi.formatClock(1788278400.5)));
assert.equal(monitorUi.shortGpuId("gpu-short"), "gpu-short");
assert.equal(
    monitorUi.shortGpuId("nvidia:uuid:GPU-7f3e2a91-4c1d-8b0e-93aa-c2f5d41b09e8").includes("\u2026"),
    true,
);


});

test("disk availability", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
for (const [disk, read, activity] of [
    [{ io_available: true, read_bytes_per_second: null, write_bytes_per_second: null }, "--", "Collecting activity…"],
    [{ io_available: true, read_bytes_per_second: 0, write_bytes_per_second: 0 }, "0 B/s", "Idle"],
    [{ read_bytes_per_second: 1024, write_bytes_per_second: null }, "1.0 KB/s", "Reading"],
    [{ read_bytes_per_second: 0, write_bytes_per_second: 2048 }, "0 B/s", "Writing"],
    [{ read_bytes_per_second: null, write_bytes_per_second: 0 }, "Not available", "Partial reading"],
    [{ io_available: false, read_bytes_per_second: -1, write_bytes_per_second: "bad" }, "Not available", "Disk activity unavailable"],
]) {
    monitorUi.configure({ fetchJson: async () => makeSample({ system: { disk } }) });
    monitorUi.recheck();
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-disk-read").textContent, read);
    assert.equal(documentStub.getElementById("monitor-disk-activity").textContent, activity);
}


});

test("system readings", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    const copyCalls = [];
    monitorUi.configure({
        fetchJson: async () => makeSample(),
        copyText: (text) => { copyCalls.push(text); return Promise.resolve(true); },
        showToast: () => {},
        invalidateCursor: () => {},
        resetStatsBaseline: () => {},
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
        pollIntervalMs: 25,
    });

    monitorUi.onTabChanged("monitor");
    monitorUi.renderInferenceSnapshot(null);

    // Wait for the first poll to land.
    await wait(80);

    const cpuValue = documentStub.getElementById("monitor-cpu-value");
    assert.equal(cpuValue.textContent, "18.4%");
    const memSub = documentStub.getElementById("monitor-memory-sub");
    assert.ok(memSub.textContent.includes("12.0 GB used of 32.0 GB"), memSub.textContent);
    const diskSub = documentStub.getElementById("monitor-disk-sub");
    assert.ok(diskSub.textContent.includes("All physical disks"));
    const ioGrid = documentStub.getElementById("monitor-disk-io");
    assert.equal(ioGrid.classList.contains("hidden"), false, "disk I/O shown when supported");
    assert.equal(documentStub.getElementById("monitor-disk-read").textContent, "1.2 MB/s");
    assert.equal(documentStub.getElementById("monitor-disk-activity").textContent, "Reading and writing");

});

test("CPU warmup", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            system: { cpu: { available: true, percent: null } },
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "--");
    assert.equal(documentStub.getElementById("monitor-cpu-sub").textContent.includes("Waiting for first sample"), true);

});

test("partial readings", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    const fetches = [];
    monitorUi.configure({
        fetchJson: async () => {
            fetches.push(1);
            return makeSample({
                system: {
                    cpu: { available: false },
                    memory: { available: true, used_bytes: 1, total_bytes: 4, percent: 25 },
                    disk: { available: true, percent: 10, read_bytes_per_second: null, write_bytes_per_second: null },
                },
            });
        },
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "Not available");
    assert.equal(documentStub.getElementById("monitor-memory-value").textContent, "25.0%");
    assert.equal(
        documentStub.getElementById("monitor-disk-io").classList.contains("hidden"),
        false,
        "disk I/O stays visible with truthful unavailable values",
    );
    assert.equal(documentStub.getElementById("monitor-disk-read").textContent, "Not available");
    assert.equal(documentStub.getElementById("monitor-disk-activity").textContent, "Disk activity unavailable");

});

