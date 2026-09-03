const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "output-cursor.js"), "utf8");
const context = { window: { LlamaGui: {} } };
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/output-cursor.js" });

const received = [];
const cursor = context.window.LlamaGui.outputCursor.create((line) => received.push(line));

assert.equal(cursor.getUrl(), "/api/output");
assert.deepEqual(
    Array.from(cursor.consume({ lines: ["one", "two"], next_cursor: 2, dropped: false }).lines),
    ["one", "two"],
);
assert.deepEqual(received, ["one", "two"]);
assert.equal(cursor.getUrl(), "/api/output?since=2");

cursor.consume({ lines: ["five"], next_cursor: 5, dropped: true });
assert.deepEqual(received, ["one", "two", "--- Earlier process output was truncated ---", "five"]);
assert.equal(cursor.getUrl(), "/api/output?since=5");

cursor.reset(10);
assert.equal(cursor.getUrl(), "/api/output?since=10");
assert.deepEqual(Array.from(cursor.consume({ lines: ["stale"], next_cursor: 5, dropped: false }).lines), []);
assert.equal(cursor.getUrl(), "/api/output?since=10");
assert.ok(!received.includes("stale"));

const staleRequest = cursor.getRequest();
cursor.reset(20);
assert.equal(cursor.isCurrent(staleRequest.epoch), false);
const staleResult = cursor.consume(
    { lines: ["old process"], next_cursor: 11, dropped: false, running: false },
    staleRequest.epoch,
);
assert.equal(staleResult.current, false);
assert.deepEqual(Array.from(staleResult.lines), []);
assert.equal(cursor.getUrl(), "/api/output?since=20");
assert.ok(!received.includes("old process"));
cursor.reset();
assert.equal(cursor.getUrl(), "/api/output");

// invalidate() rejects in-flight responses without discarding the cursor.
// Clearing the terminal relies on this: a reset() to a null cursor would
// make the next cursorless request replay the whole backend backlog.
cursor.consume({ lines: ["keep"], next_cursor: 7, dropped: false });
assert.equal(cursor.getUrl(), "/api/output?since=7");
const inFlight = cursor.getRequest();
cursor.invalidate();
assert.equal(cursor.getUrl(), "/api/output?since=7", "invalidate must keep the cursor");
assert.equal(cursor.isCurrent(inFlight.epoch), false, "invalidate must reject in-flight requests");
const staleAfterInvalidate = cursor.consume(
    { lines: ["replayed backlog"], next_cursor: 3, dropped: false },
    inFlight.epoch,
);
assert.equal(staleAfterInvalidate.current, false);
assert.ok(!received.includes("replayed backlog"));
const freshAfterInvalidate = cursor.consume({ lines: ["fresh"], next_cursor: 8, dropped: false });
assert.equal(freshAfterInvalidate.current, true);
assert.deepEqual(received.slice(-2), ["keep", "fresh"]);
assert.equal(cursor.getUrl(), "/api/output?since=8");

console.log("output cursor unit tests passed");
