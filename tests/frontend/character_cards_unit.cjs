const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { character, chunk, pngCard, cardFile } = require("./character_card_fixtures.cjs");

const context = vm.createContext({ window: {}, TextDecoder, atob, console });
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../ui/js/character-cards.js"), "utf8"), context);
const { readFile } = context.window.LlamaGui.characterCards;

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
