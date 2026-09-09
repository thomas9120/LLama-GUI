const { deflateSync } = require("node:zlib");

const character = {
    name: "Éloïse", description: "{{char}} is an astronomer.", personality: "Curious",
    scenario: "At the observatory with {{user}}.", first_mes: "Hello {{user}}, I'm {{char}}. 🌙",
    mes_example: "<START>\n{{user}}: Hello!\n{{char}}: Welcome!",
};

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
}

function pngCard(entries = [["chara", JSON.stringify(character)]]) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
        ...entries.map(([key, json]) => chunk("tEXt", Buffer.from(`${key}\0${Buffer.from(json).toString("base64")}`))),
        chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

function cardFile(data = character, name = "character.json") {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    return { name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

module.exports = { character, chunk, pngCard, cardFile };
