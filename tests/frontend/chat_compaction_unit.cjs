const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const context = { window: { LlamaGui: {} }, console, TextDecoder, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(context);
for (const file of ["chat-rendering.js", "chat-tools.js", "chat-compaction.js"]) {
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

    setup();
    const tools = context.window.LlamaGui.chatTools;
    tools.setEnabled(true);
    const toolMessages = [{ role: "assistant", content: "", tool_calls: [{ id: "clock", type: "function", function: { name: "get_datetime", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "clock", content: '{"result":"2026-09-10T12:00:00+00:00","timezone":"UTC"}' }];
    const withTools = transcript.map((message, index) => ({ ...message, ...([1, 5].includes(index) ? { toolMessages } : {}) }));
    await compact({ messages: withTools, body: { model: "test", max_tokens: 128, tools: tools.getDefinitions(), messages: [] } });
    assert.equal(requests[0].messages.filter(msg => msg.role === "tool").length, 2, "count all historical tool exchanges before compaction");
    assert.equal(requests.at(-1).messages.filter(msg => msg.role === "tool").length, 1, "keep the recent tool exchange after compaction");
    assert.ok(generations.every(body => !body.tools), "summaries do not call tools");
    assert.deepEqual(generations.flatMap(body => JSON.parse(body.messages[1].content).messages).find(msg => msg.toolMessages).toolMessages, toolMessages,
        "older tool results are included in summary data");

    // Images are counted as media in working context, but summary input stays text-only.
    setup();
    const ref = name => ({ id: name, name: `${name}.png`, type: "image/png", size: 100 });
    const withImages = transcript.map((message, index) => ({ ...message,
        ...([0, 4].includes(index) ? { attachments: [ref(`image-${index}`)] } : {}) }));
    const imageOriginal = JSON.stringify(withImages);
    const requestMessages = messages => context.window.LlamaGui.chatTools.requestMessages(messages.map(message => ({
        ...message, content: message.attachments?.length ? [
            { type: "text", text: message.content },
            ...message.attachments.map(image => ({ type: "image_url", image_url: { url: `data:image/png;base64,${image.id === "oversized" ? "A".repeat(12000) : image.id}` } })),
        ] : message.content,
    })));
    const imageResult = await compact({ messages: withImages, draft: "", draftImages: [ref("draft")], requestMessages });
    assert.equal(JSON.stringify(withImages), imageOriginal, "compaction never changes stored attachments");
    assert.ok(Array.isArray(requests[0].messages[1].content), "before count includes old image bytes");
    assert.ok(generations.every(body => !JSON.stringify(body).includes("data:image")));
    const summaryData = generations.map(body => JSON.parse(body.messages[1].content).messages).flat();
    assert.match(summaryData[0].content, /Image attached: "image-0.png"; image content unavailable/);
    assert.equal(summaryData[0].attachments, undefined);
    const after = requests.at(-2);
    assert.match(after.messages[2].content, /Older images omitted[\s\S]*image-0.png/);
    assert.ok(!JSON.stringify(after).includes("base64,image-0"));
    assert.ok(JSON.stringify(after).includes("base64,image-4"), "recent image stays in context");
    assert.equal(requests.at(-1).messages.at(-1).content[1].image_url.url, "data:image/png;base64,draft",
        "final fit check includes an image-only draft");
    setup();
    const laterImages = [...withImages, { role: "user", content: "Next" }, { role: "assistant", content: "Answer" }];
    const nextResult = await compact({ messages: laterImages, previous: imageResult, requestMessages });
    const nextWorking = api.workingMessages(laterImages, nextResult);
    assert.match(nextWorking[1].content, /image-0.png[\s\S]*image-4.png/,
        "repeated compaction derives all omitted image placeholders from history");
    assert.equal(JSON.stringify(withImages), imageOriginal);

    setup();
    await assert.rejects(compact({ messages: withImages, requestMessages,
        draft: "", draftImages: [ref("oversized")] }), /recent messages still exceed context/);

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
