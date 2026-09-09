(function () {
    window.LlamaGui = window.LlamaGui || {};

    const MAX_FILE_BYTES = 20 * 1024 * 1024;
    const MAX_CARD_BYTES = 1024 * 1024;
    const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

    function parseJson(text) {
        try {
            return JSON.parse(text.replace(/^\uFEFF/, ""));
        } catch (error) {
            console.debug("Invalid character card JSON", error);
            throw new Error("The character card contains invalid JSON.");
        }
    }

    // Tavern PNG cards store UTF-8 JSON as base64 in a tEXt chunk. CCv3
    // takes precedence over the legacy chara copy when both are present.
    function readPng(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const cards = {};
        let offset = 8;
        let ended = false;
        while (offset + 12 <= bytes.length) {
            const length = view.getUint32(offset);
            const end = offset + 8 + length;
            if (end + 4 > bytes.length) throw new Error("The PNG file is truncated or damaged.");
            const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
            if (offset === 8 && (type !== "IHDR" || length !== 13)) throw new Error("The PNG header is invalid.");
            if (type === "tEXt") {
                const data = bytes.subarray(offset + 8, end);
                const separator = data.indexOf(0);
                if (separator > 0 && separator <= 79) {
                    const keyword = String.fromCharCode(...data.subarray(0, separator));
                    if (keyword === "chara" || keyword === "ccv3") {
                        if (length > Math.ceil(MAX_CARD_BYTES * 4 / 3) + 80) throw new Error("Character card data exceeds the 1 MB limit.");
                        let crc = 0xffffffff;
                        for (let i = offset + 4; i < end; i++) {
                            crc ^= bytes[i];
                            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
                        }
                        if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end)) throw new Error("The PNG character data is damaged.");
                        cards[keyword] = data.subarray(separator + 1);
                    }
                }
            }
            offset = end + 4;
            if (type === "IEND") { ended = length === 0; break; }
        }
        if (!ended) throw new Error("The PNG file is truncated or damaged.");
        const encoded = cards.ccv3 || cards.chara;
        if (!encoded) throw new Error("This PNG has no character card data. Choose an exported character card, not a plain portrait.");
        let text;
        try {
            const binary = atob(decoder.decode(encoded));
            if (binary.length > MAX_CARD_BYTES) throw new Error("Character data is too large.");
            text = decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
        } catch (error) {
            console.debug("Invalid PNG character card encoding", error);
            throw new Error("The PNG character data is not valid base64-encoded UTF-8.");
        }
        return parseJson(text);
    }

    function buildCharacter(card, originalPrompt) {
        if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("This file is not a character card.");
        if (card.spec && !["chara_card_v2", "chara_card_v3"].includes(card.spec)) throw new Error("This character card version is not supported.");
        const data = card.spec ? card.data : card;
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The character card is missing its data.");
        const fields = ["name", "description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions", "nickname"];
        for (const key of fields) {
            if (data[key] !== undefined && typeof data[key] !== "string") throw new Error(`Character card field ${key} must be text.`);
        }
        const name = (data.name || "").trim();
        if (!name || !fields.slice(1, 6).some(key => typeof data[key] === "string")) throw new Error("The file needs a character name and character details or a greeting.");
        const characterName = data.nickname?.trim() || name;
        const replaceNames = text => text.replace(/\{\{\s*(char|user)\s*\}\}|<(char|bot|user)>/gi,
            (_, macro, legacy) => (macro || legacy).toLowerCase() === "user" ? "User" : characterName);
        const basePrompt = originalPrompt.trim() || "You are a helpful assistant.";
        const system = (data.system_prompt || "").trim();
        const sections = [system ? system.replace(/\{\{\s*original\s*\}\}/gi, () => basePrompt) : basePrompt,
            `Write as ${characterName} in a conversation with User.`];
        for (const [key, label] of [["description", "Description"], ["personality", "Personality"],
            ["scenario", "Scenario"], ["mes_example", "Example dialogue"], ["post_history_instructions", "Additional instructions"]]) {
            if (data[key]?.trim()) sections.push(`${label}:\n${data[key].replace(/\{\{\s*original\s*\}\}/gi, "")}`);
        }
        const systemPrompt = replaceNames(sections.join("\n\n"));
        const greeting = replaceNames(data.first_mes || "");
        const notices = [];
        if (data.post_history_instructions?.trim()) notices.push("Post-history instructions were added to System Prompt.");
        const omitted = [];
        if (data.character_book) omitted.push("lorebook");
        if (data.alternate_greetings?.length || data.group_only_greetings?.length) omitted.push("alternate greetings");
        if (data.assets?.length) omitted.push("assets");
        if (data.extensions && Object.keys(data.extensions).length) omitted.push("extensions");
        if (omitted.length) notices.push(`Not applied: ${omitted.join(", ")}.`);
        if (/\{\{[^}]+\}\}/.test(systemPrompt + greeting)) notices.push("Other card macros remain as text; review System Prompt and the greeting.");
        return { name, systemPrompt, greeting, notices };
    }

    async function readFile(file, originalPrompt = "") {
        if (!file || !/\.(json|png)$/i.test(file.name)) throw new Error("Choose a JSON or PNG character card.");
        if (file.size > MAX_FILE_BYTES) throw new Error("Choose a character card smaller than 20 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const png = PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
        if (/\.png$/i.test(file.name) && !png) throw new Error("This file is not a valid PNG character card.");
        if (!png && bytes.length > MAX_CARD_BYTES) throw new Error("Character card JSON exceeds the 1 MB limit.");
        const card = png ? readPng(bytes) : parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return buildCharacter(card, originalPrompt);
    }

    window.LlamaGui.characterCards = { readFile };
})();
