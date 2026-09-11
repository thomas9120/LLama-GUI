const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../ui/js/chat-tools.js"), "utf8");

function load({ storage = new Map(), blocked = false, instant = "2026-09-10T12:34:56Z", checkbox = null } = {}) {
    const context = {
        window: { LlamaGui: {} },
        document: { getElementById: (id) => id === "chat-datetime-enabled" ? checkbox : null },
        console: { debug() {} },
        Date: class extends Date { constructor() { super(typeof instant === "function" ? instant() : instant); } }, Intl,
        localStorage: {
            getItem(key) { if (blocked) throw new Error("blocked"); return storage.get(key); },
            setItem(key, value) { if (blocked) throw new Error("blocked"); storage.set(key, value); },
        },
    };
    vm.runInNewContext(source, context);
    return context.window.LlamaGui.chatTools;
}

const storage = new Map();
const tools = load({ storage });
assert.equal(tools.getDefinitions().length, 0, "opt-in by default");
assert.equal(tools.getInstructions(), "", "disabled tools add no instructions");
tools.setEnabled(true);
assert.match(tools.getInstructions(), /get_datetime.*today.*web search/);
assert.equal(load({ storage }).getDefinitions()[0].function.name, "get_datetime", "remember the preference");
tools.setEnabled(false);
assert.equal(load({ storage }).getDefinitions().length, 0, "remember disabling too");
const blocked = load({ blocked: true });
blocked.setEnabled(true);
assert.equal(blocked.getDefinitions().length, 1, "blocked storage still allows session use");
const checkbox = { checked: false, onchange: null };
const syncedTools = load({ checkbox });
syncedTools.init();
syncedTools.setEnabled(true, { persist: false });
assert.equal(checkbox.checked, true, "programmatic restores synchronize an initialized checkbox");
syncedTools.setEnabled(false, { persist: false });
assert.equal(checkbox.checked, false);

const originalTZ = process.env.TZ;
try {
    for (const [zone, instant, expected] of [
        ["UTC", "2026-09-10T12:34:56Z", "2026-09-10T12:34:56+00:00"],
        ["America/New_York", "2026-09-10T02:34:56Z", "2026-09-09T22:34:56-04:00"],
        ["America/New_York", "2026-01-10T02:34:56Z", "2026-01-09T21:34:56-05:00"],
        ["Asia/Kathmandu", "2026-09-10T22:34:56Z", "2026-09-11T04:19:56+05:45"],
        ["America/St_Johns", "2026-01-10T12:34:56Z", "2026-01-10T09:04:56-03:30"],
    ]) {
        process.env.TZ = zone;
        const value = load({ instant }).currentDateTime();
        assert.equal(value.result, expected);
        assert.equal(value.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
} finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
}

tools.setEnabled(true);
const calls = [];
tools.collectCalls(calls, [{ index: 0, id: "call_", type: "function", function: { name: "get_", arguments: "{" } }]);
tools.collectCalls(calls, [{ index: 0, id: "1", function: { name: "datetime", arguments: "}" } }]);
assert.equal(calls[0].function.name, "get_datetime");
const results = tools.executeCalls(calls);
assert.equal(results[0].role, "tool");
assert.equal(results[0].tool_call_id, "call_1");
assert.match(JSON.parse(results[0].content).result, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
tools.setEnabled(false);
assert.throws(() => tools.executeCalls(calls), /disabled/);
tools.setEnabled(true);
for (const [name, args] of [["exec_shell_command", "{}"], ["get_datetime", "{"], ["get_datetime", "null"], ["get_datetime", "[]"], ["get_datetime", '{"format":"%Y"}']]) {
    assert.throws(() => tools.executeCalls([{ id: "1", function: { name, arguments: args } }]), /only supports|arguments/);
}
assert.throws(() => tools.executeCalls([calls[0], calls[0]]), /only supports/);
assert.throws(() => tools.collectCalls([], [{ index: 4 }]), /invalid tool/);
assert.throws(() => tools.collectCalls([], [{ index: -1 }]), /invalid tool/);
assert.throws(() => tools.collectCalls([], [{ index: 0, function: { arguments: "x".repeat(4097) } }]), /oversized/);
assert.throws(() => tools.executeCalls([, calls[0]]), /only supports/);
for (const malformed of [{ id: "1" }, { id: "1", function: null }]) {
    assert.throws(() => tools.executeCalls([malformed]), /Chat only supports/,
        "missing function metadata gets a recoverable validation error");
}

let clockReads = 0;
const advancingClock = load({ instant: () => Date.parse("2026-09-10T12:34:59Z") + clockReads++ * 1000 });
advancingClock.setEnabled(true);
const batch = Array.from({ length: 4 }, (_, index) => ({ ...calls[0], id: `batch-${index}` }));
assert.throws(() => advancingClock.executeCalls([...batch, { id: "bad" }]), /Chat only supports/);
assert.equal(clockReads, 0, "validate the whole batch before reading the clock");
const batchResults = advancingClock.executeCalls(batch);
assert.deepEqual(Array.from(batchResults, result => result.tool_call_id), batch.map(call => call.id));
assert.equal(new Set(batchResults.map(result => result.content)).size, 1, "one clock snapshot per batch");
assert.equal(clockReads, 1);
assert.notEqual(advancingClock.executeCalls(batch)[0].content, batchResults[0].content,
    "a later batch reads the clock again");

const exchange = [{ role: "assistant", content: "", tool_calls: calls, reasoning_content: "Check the clock." }, ...results];
const transcript = [{ role: "user", content: "What time is it?" }, { role: "assistant", content: "The current time.", toolMessages: exchange }];
const wire = JSON.parse(JSON.stringify(tools.requestMessages(transcript)));
assert.deepEqual(wire.map(msg => msg.role), ["user", "assistant", "tool", "assistant"]);
assert.equal(wire[1].reasoning_content, "Check the clock.");
assert.equal(wire[2].tool_call_id, wire[1].tool_calls[0].id);
assert.equal(transcript.length, 2, "request expansion must not change transcript indices");
assert.equal(tools.requestMessages([{ role: "assistant", content: "", toolMessages: exchange }]).length, 2,
    "a failed continuation keeps the completed tool exchange in context");
let toolChanges = 0;
tools.configureWorkspace({ canMutate: () => false, onChange: () => { toolChanges += 1; } });
assert.equal(tools.setEnabled(false), false, "workspace ownership gates tool preference mutation");
assert.equal(tools.setEnabled(false, { force: true }), false, "callers cannot bypass workspace ownership");
assert.equal(tools.isEnabled(), true);
tools.configureWorkspace({ canMutate: () => true, onChange: () => { toolChanges += 1; } });
assert.equal(tools.setEnabled(false), true);
assert.equal(toolChanges, 1);
console.log("chat_tools_unit.cjs: all tests passed");
