const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { character, chunk, pngCard, cardFile } = require("./character_card_fixtures.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../../ui/js/character-cards.js"), "utf8");
const context = vm.createContext({ window: {}, TextDecoder, atob, console });
vm.runInContext(source, context);
const { readFile } = context.window.LlamaGui.characterCards;

function readWithTimeout(data) {
    const bytes = Uint8Array.from(Buffer.from(JSON.stringify(data)));
    const sandbox = { window: {}, TextDecoder, atob, console, bytes };
    // Include readFile's promise continuations in the VM timeout: a backtracking
    // regression must fail the test instead of blocking the runner for minutes.
    vm.runInNewContext(source + `
        window.LlamaGui.characterCards.readFile({
            name: "card.json", size: bytes.length, arrayBuffer: () => bytes.buffer,
        }).then(card => { globalThis.result = card; }, error => { globalThis.failure = error; });
    `, sandbox, { timeout: 5000, microtaskMode: "afterEvaluate" });
    if (sandbox.failure) throw sandbox.failure;
    assert.ok(sandbox.result, "the timed import must settle inside the VM");
    return sandbox.result;
}

(async () => {
    const legacy = await readFile(cardFile());
    assert.equal(legacy.name, "Éloïse");
    assert.equal(legacy.greeting, "Hello User, I'm Éloïse. 🌙");
    assert.match(legacy.systemPrompt, /Description:\nÉloïse is an astronomer/);
    assert.match(legacy.systemPrompt, /Personality:\nCurious/);
    assert.match(legacy.systemPrompt, /Scenario:\nAt the observatory with User/);
    assert.match(legacy.systemPrompt, /Example dialogue:/);

    const v2 = { spec: "chara_card_v2", spec_version: "2.0", data: {
        ...character, system_prompt: "{{original}} Stay in character as {{char}}.",
        creator_notes: "NEVER IN PROMPT", tags: ["NEVER IN PROMPT"],
        post_history_instructions: "Be concise.", alternate_greetings: ["Hi"],
        character_book: { entries: [] }, extensions: { arbitrary: "NEVER IN PROMPT" },
    } };
    const loaded = await readFile(cardFile(v2));
    assert.match(loaded.systemPrompt, /You are a helpful assistant\. Stay in character as Éloïse/);
    assert.match(loaded.systemPrompt, /Additional instructions:\nBe concise/);
    assert.doesNotMatch(loaded.systemPrompt, /NEVER IN PROMPT/);
    assert.match(loaded.notices.join(" "), /lorebook, alternate greetings, extensions/);

    const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: { ...character, nickname: "Ellie", assets: [{}] } };
    const png = await readFile(cardFile(pngCard([["chara", JSON.stringify(v2)], ["ccv3", JSON.stringify(v3)]]), "portrait.png"));
    assert.equal(png.greeting, "Hello User, I'm Ellie. 🌙");
    assert.match(png.notices.join(" "), /assets/);
    assert.equal((await readFile(cardFile(pngCard(), "portrait.PNG"))).systemPrompt, legacy.systemPrompt);
    assert.equal((await readFile(cardFile(Buffer.from("\ufeff" + JSON.stringify(character))))).name, character.name);
    assert.equal((await readFile(cardFile({ name: "Quiet", description: "Silent observer" }))).greeting, "");
    assert.match((await readFile(cardFile({ ...character, description: "{{unsupported}}" }))).notices.join(" "), /macros remain as text/);
    assert.match((await readFile(cardFile({ ...character, name: "$&<img>", first_mes: "{{char}}" }))).greeting, /^\$&<img>$/);

    const braces = "{".repeat(900000);
    for (const field of ["description", "first_mes"]) {
        const loaded = readWithTimeout({ name: "Braces", [field]: braces });
        assert.ok((field === "description" ? loaded.systemPrompt : loaded.greeting).includes(braces));
        assert.equal(loaded.notices.length, 0);
    }

    for (const field of ["name", "nickname"]) {
        await assert.rejects(readFile(cardFile({ ...character, [field]: "x".repeat(257) })), /256 characters/);
    }
    const longName = "x".repeat(256);
    for (const field of ["description", "first_mes"]) {
        const oversized = { name: longName, [field]: "{{char}}".repeat(5000) };
        await assert.rejects(readFile(cardFile(oversized)), /expanded text limit/);
        await assert.rejects(readFile(cardFile(pngCard([["chara", JSON.stringify(oversized)]]), "card.png")), /expanded text limit/);
    }
    // Both outputs share one budget; neither individually exceeds the limit.
    await assert.rejects(readFile(cardFile({ name: longName,
        description: "<BOT>".repeat(2500), first_mes: "{{ CHAR }}".repeat(2500),
    })), /expanded text limit/);
    await assert.rejects(readFile(cardFile({ ...character, nickname: longName, first_mes: "<char>".repeat(5000) })), /expanded text limit/);
    await assert.rejects(readFile(cardFile({ ...character, system_prompt: "{{original}}".repeat(10000) }), "x".repeat(500000)), /expanded text limit/);

    // Allow the exact combined limit, then reject one additional character.
    const boundary = { name: longName, description: "{{char}}".repeat(1000), first_mes: "" };
    const prompt = (await readFile(cardFile(boundary))).systemPrompt;
    boundary.first_mes = "x".repeat(1024 * 1024 - prompt.length);
    const atLimit = await readFile(cardFile(boundary));
    assert.equal(atLimit.systemPrompt.length + atLimit.greeting.length, 1024 * 1024);
    await assert.rejects(readFile(cardFile({ ...boundary, first_mes: boundary.first_mes + "x" })), /expanded text limit/);

    for (const data of [null, [], {}, { name: "Other JSON" }, { ...character, first_mes: [] }, { spec: "other", data: character }]) {
        await assert.rejects(readFile(cardFile(data)));
    }
    await assert.rejects(readFile(cardFile(Buffer.from("bad json"))), /invalid JSON/);
    await assert.rejects(readFile(cardFile(Buffer.from("bad png"), "file.png")), /valid PNG/);
    await assert.rejects(readFile(cardFile(pngCard([]), "file.png")), /no character card data/);
    await assert.rejects(readFile(cardFile(pngCard().subarray(0, -5), "file.png")), /truncated/);
    const damaged = pngCard();
    damaged[damaged.indexOf("chara") + 6] ^= 1;
    await assert.rejects(readFile(cardFile(damaged, "file.png")), /data is damaged/);
    const overflowing = pngCard();
    overflowing.writeUInt32BE(0xffffffff, 33);
    await assert.rejects(readFile(cardFile(overflowing, "file.png")), /truncated/);
    const noCard = pngCard([]);
    const badEncoding = Buffer.concat([noCard.subarray(0, 33), chunk("tEXt", Buffer.from("chara\0%%%")), noCard.subarray(33)]);
    await assert.rejects(readFile(cardFile(badEncoding, "file.png")), /base64/);
    await assert.rejects(readFile({ name: "big.png", size: 21 * 1024 * 1024 }), /20 MB/);
    await assert.rejects(readFile(cardFile(Buffer.alloc(1024 * 1024 + 1))), /1 MB/);
    await assert.rejects(readFile(cardFile(character, "card.exe")), /JSON or PNG/);
    console.log("character_cards_unit.cjs: all tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
