const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const context = { window: { LlamaGui: {} }, console, TextDecoder };
vm.createContext(context);
for (const file of ["chat-rendering.js", "chat-compaction.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "ui/js", file), "utf8"), context);
}
const api = context.window.LlamaGui.chatCompaction;
const transcript = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: i < 4 ? `${i}:` + "detail ".repeat(580) : `Recent ${i}`,
    ...(i === 1 ? { sources: [{ url: "https://example.com" }], reasoning_content: "Reasoning", status: "stopped" } : {}),
}));
const original = JSON.stringify(transcript);
let requests, generations, mode;
function setup(nextMode = "ok") {
    requests = []; generations = []; mode = nextMode;
    context.fetch = async (url, options) => {
        options.signal.throwIfAborted();
        const body = JSON.parse(options.body);
        requests.push(body);
        assert.equal(options.headers.Authorization, "Bearer test");
        if (url.endsWith("/context")) {
            if (mode === "unavailable") return { ok: true, json: async () => ({ status: "unavailable" }) };
            const tokens = Math.ceil(JSON.stringify(body.messages).length / 4);
            const capacity = mode === "too-small" ? 600 : 2048;
            const remaining = capacity - tokens - (body.max_tokens || 0);
            return { ok: true, json: async () => ({ prompt_tokens: tokens, capacity, remaining, status: remaining < 0 ? "overflow" : "ok" }) };
        }
        assert.equal(body.gui_require_context, true);
        assert.equal(body.web_search, undefined);
        assert.equal(body.max_tokens, 512);
        const lastCount = requests.at(-2);
        assert.deepEqual(lastCount, body, "every generation has an identical counted request including output reserve");
        generations.push(body);
        let read = false;
        return { ok: true, body: { getReader: () => ({
            read: async () => {
                if (read) return { done: true };
                read = true;
                const output = mode === "no-savings" ? "long summary ".repeat(3000) : "Decisions, constraints, and remaining questions.";
                const event = mode === "error" ? { error: { message: "Server unavailable" } }
                    : { choices: [{ delta: { content: mode === "empty" ? "" : output }, finish_reason: mode === "length" ? "length" : mode === "eof" ? null : "stop" }] };
                return { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`) };
            }, cancel: async () => {},
        }) } };
    };
}
function compact(extra = {}) {
    return api.compact({ messages: transcript, previous: null,
        body: { model: "test", max_tokens: 128, web_search: true, messages: [{ role: "system", content: "Original instructions" }] },
        draft: "Unsent question", signal: new AbortController().signal,
        headers: { Authorization: "Bearer test" }, onProgress: () => {}, ...extra });
}
(async () => {
    setup();
    const result = await compact();
    assert.equal(result.end, 4);
    assert.ok(result.savedTokens > 0);
    assert.ok(generations.length > 1, "oversized history is summarized in fitting chunks");
    const data = generations.map(request => JSON.parse(request.messages[1].content));
    assert.deepEqual(data.flatMap(item => item.messages), transcript.slice(0, 4), "every older message is covered exactly once");
    assert.equal(data[1].previous_summary, result.summary);
    assert.ok(data[0].instructions[0].content.includes("Original instructions"));
    const working = api.workingMessages(transcript, result);
    assert.deepEqual(Array.from(working.slice(2)), transcript.slice(4));
    assert.equal(working[0].role, "user");
    assert.equal(working[1].role, "assistant");
    assert.equal(JSON.stringify(transcript), original);
    assert.equal(requests.at(-1).messages.at(-1).content, "Unsent question");
    assert.equal(requests.at(-1).max_tokens, 128);
    await assert.rejects(compact({ previous: result }), /Keep chatting/);

    setup();
    const extended = [...transcript, { role: "user", content: "New question" }, { role: "assistant", content: "New answer" }];
    await compact({ messages: extended, previous: result });
    assert.equal(JSON.parse(generations[0].messages[1].content).previous_summary, result.summary);
    assert.deepEqual(JSON.parse(generations[0].messages[1].content).messages, transcript.slice(4, 6));

    for (const [failure, message] of [["unavailable", /token counting/], ["too-small", /do not fit/],
        ["length", /output limit/], ["empty", /complete summary/], ["eof", /complete summary/],
        ["error", /Server unavailable/], ["no-savings", /do not fit|did not save/]]) {
        setup(failure);
        await assert.rejects(compact(), message);
        assert.equal(JSON.stringify(transcript), original);
    }
    setup();
    const controller = new AbortController();
    await assert.rejects(compact({ signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
    assert.equal(generations.length, 0);
    assert.equal(api.valid({ end: 99, summary: "bad" }, transcript), false);
    assert.equal(api.workingMessages(transcript, null), transcript);
    console.log("chat_compaction_unit.cjs: all tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
