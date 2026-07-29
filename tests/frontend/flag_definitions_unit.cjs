const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const FLAG_SOURCES = [
    "ui/js/flags/categories.js",
    "ui/js/flags/options.js",
    "ui/js/flags/chat-templates.js",
    "ui/js/flags/definitions.js",
];
const SUPPORTED_TOOLS = new Set(["server", "cli", "both"]);
const SUPPORTED_TYPES = new Set(["bool", "int", "float", "text", "text_list", "path", "enum", "multi_enum"]);

function hasText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumberLike(value) {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string" || value.trim() === "") return false;
    return Number.isFinite(Number(value));
}

function isIntegerLike(value) {
    return isFiniteNumberLike(value) && Number.isInteger(Number(value));
}

function validateDefaultValue(flag, addWarning) {
    if (!Object.prototype.hasOwnProperty.call(flag, "default")) return;
    const value = flag.default;

    if (flag.type === "bool" && typeof value !== "boolean") {
        addWarning(`default for "${flag.id}" should be boolean for bool flags.`);
    } else if (flag.type === "int" && !isIntegerLike(value)) {
        addWarning(`default for "${flag.id}" should be an integer-compatible value.`);
    } else if (flag.type === "float" && !isFiniteNumberLike(value)) {
        addWarning(`default for "${flag.id}" should be a finite number-compatible value.`);
    } else if ((flag.type === "text" || flag.type === "path") && typeof value !== "string" && value !== undefined) {
        addWarning(`default for "${flag.id}" should be a string for ${flag.type} flags.`);
    } else if (flag.type === "text_list" && !Array.isArray(value) && typeof value !== "string") {
        addWarning(`default for "${flag.id}" should be an array or newline-separated string for text_list flags.`);
    } else if (flag.type === "enum") {
        const options = Array.isArray(flag.options) ? flag.options : [];
        const optionValues = new Set(options.map((option) => String(option && option.value)));
        if (!optionValues.has(String(value))) {
            addWarning(`default for "${flag.id}" is not present in its enum options.`);
        }
    } else if (flag.type === "multi_enum" && !Array.isArray(value) && typeof value !== "string") {
        addWarning(`default for "${flag.id}" should be an array or comma-separated string for multi_enum flags.`);
    }
}

function validateOptions(flag, addError, addWarning) {
    if (flag.type !== "enum" && flag.type !== "multi_enum") return;
    if (!Array.isArray(flag.options) || flag.options.length === 0) {
        addError(`"${flag.id}" is ${flag.type} but has no usable options array.`);
        return;
    }

    const optionValues = new Set();
    for (const [index, option] of flag.options.entries()) {
        if (!option || typeof option !== "object") {
            addError(`"${flag.id}" option ${index} is not an object.`);
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(option, "value")) {
            addError(`"${flag.id}" option ${index} is missing value.`);
        }
        if (!hasText(option.label)) {
            addWarning(`"${flag.id}" option ${index} is missing a readable label.`);
        }
        const valueKey = String(option.value);
        if (optionValues.has(valueKey)) {
            addWarning(`"${flag.id}" has duplicate option value "${valueKey}".`);
        }
        optionValues.add(valueKey);
    }
}

// Cross-checks flag.submenu against each category's optional submenuOrder hint, so a typo
// in either place fails loudly instead of silently creating an extra unordered submenu.
// Categories without submenuOrder are skipped: the hint is opt-in.
function validateSubmenuOrder(flags, categories, addError) {
    const usedByCategory = new Map();
    for (const flag of flags) {
        if (!flag || typeof flag !== "object") continue;
        const submenu = typeof flag.submenu === "string" ? flag.submenu.trim() : "";
        if (!submenu) continue;
        if (!usedByCategory.has(flag.category)) usedByCategory.set(flag.category, new Set());
        usedByCategory.get(flag.category).add(submenu);
    }

    for (const category of categories || []) {
        if (!category || !Array.isArray(category.submenuOrder)) continue;
        const declared = new Set(category.submenuOrder);
        const used = usedByCategory.get(category.id) || new Set();

        if (declared.size !== category.submenuOrder.length) {
            addError(`Category "${category.id}" has duplicate names in submenuOrder.`);
        }
        for (const name of used) {
            if (!declared.has(name)) {
                addError(`Submenu "${name}" in category "${category.id}" is missing from submenuOrder.`);
            }
        }
        for (const name of declared) {
            if (!used.has(name)) {
                addError(`Category "${category.id}" lists unused submenu "${name}" in submenuOrder.`);
            }
        }
    }
}

function validateFlags(flags, categories) {
    const errors = [];
    const warnings = [];
    const categoryIds = new Set((categories || []).map((category) => category && category.id).filter(Boolean));
    const flagIds = new Map();
    const cliFlags = new Map();
    const addError = (message) => errors.push(message);
    const addWarning = (message) => warnings.push(message);

    if (!Array.isArray(flags)) {
        addError("FLAGS must be an array.");
        return { errors, warnings };
    }

    for (const [index, flag] of flags.entries()) {
        const label = flag && flag.id ? `"${flag.id}"` : `at index ${index}`;
        if (!flag || typeof flag !== "object") {
            addError(`Flag ${label} must be an object.`);
            continue;
        }

        if (!hasText(flag.id)) {
            addError(`Flag at index ${index} is missing id.`);
        } else if (flagIds.has(flag.id)) {
            addError(`Duplicate flag id "${flag.id}" at indexes ${flagIds.get(flag.id)} and ${index}.`);
        } else {
            flagIds.set(flag.id, index);
        }

        if (!hasText(flag.flag)) {
            addError(`Flag ${label} is missing CLI flag string.`);
        } else {
            const existing = cliFlags.get(flag.flag);
            if (existing && !flag.allow_duplicate_cli_flag) {
                addWarning(`CLI flag "${flag.flag}" is used by both "${existing}" and ${label}.`);
            } else {
                cliFlags.set(flag.flag, flag.id || `index ${index}`);
            }
        }

        if (!categoryIds.has(flag.category)) {
            addError(`Flag ${label} has invalid category "${flag.category}".`);
        }
        if (!SUPPORTED_TOOLS.has(flag.tool)) {
            addError(`Flag ${label} has invalid tool "${flag.tool}".`);
        }
        if (!SUPPORTED_TYPES.has(flag.type)) {
            addError(`Flag ${label} has unsupported type "${flag.type}".`);
        }
        if (Object.prototype.hasOwnProperty.call(flag, "false_flag")) {
            if (flag.type !== "bool" && flag.type !== "enum") {
                addError(`Flag ${label} has false_flag but is not type bool or enum.`);
            } else if (!hasText(flag.false_flag)) {
                addError(`Flag ${label} has an empty false_flag.`);
            } else {
                const existing = cliFlags.get(flag.false_flag);
                if (existing && !flag.allow_duplicate_cli_flag) {
                    addWarning(`CLI false_flag "${flag.false_flag}" is used by both "${existing}" and ${label}.`);
                } else {
                    cliFlags.set(flag.false_flag, `${flag.id || `index ${index}`} false_flag`);
                }
            }
        }

        validateOptions(flag, addError, addWarning);
        validateDefaultValue(flag, addWarning);
    }

    for (const categoryId of categoryIds) {
        if (flagIds.has(categoryId)) {
            addWarning(`Category id "${categoryId}" collides with flag id "${categoryId}".`);
        }
    }

    validateSubmenuOrder(flags, categories, addError);

    return { errors, warnings };
}

function loadCurrentDefinitions() {
    const source = FLAG_SOURCES
        .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
        .join("\n");
    const context = {};
    vm.createContext(context);
    vm.runInContext(
        `${source}\nthis.__FLAGS = FLAGS; this.__FLAG_CATEGORIES = FLAG_CATEGORIES;`,
        context,
        { filename: "ui/js/flags/definitions.js" }
    );
    return { flags: context.__FLAGS, categories: context.__FLAG_CATEGORIES };
}

function makeFlag(overrides = {}) {
    return {
        id: "example",
        flag: "--example",
        category: "server",
        type: "bool",
        label: "Example",
        desc: "Example flag",
        tool: "server",
        default: false,
        ...overrides,
    };
}

function assertIncludes(messages, expected) {
    assert.ok(messages.includes(expected), `expected message: ${expected}\nreceived:\n${messages.join("\n")}`);
}

const current = loadCurrentDefinitions();
assert.deepEqual(validateFlags(current.flags, current.categories), {
    errors: [],
    warnings: [
        'Category id "conversation" collides with flag id "conversation".',
        'Category id "lora" collides with flag id "lora".',
        'Category id "grammar" collides with flag id "grammar".',
    ],
});

{
    const jinja = current.flags.find((flag) => flag.id === "jinja");
    assert.equal(jinja.default, true);
    assert.equal(jinja.false_flag, "--no-jinja");

    const tools = current.flags.find((flag) => flag.id === "tools");
    assert.ok(!tools.options.some((option) => option.value === "apply_diff"));
}

// Configure keeps exactly these six sampling flags at the top level; every other sampling
// flag lives in a submenu. See docs/design-docs/V2-planning-log.md item 2.
{
    const SAMPLING_TOP_LEVEL = new Set([
        "temperature",
        "top_k",
        "top_p",
        "min_p",
        "repeat_penalty",
        "presence_penalty",
    ]);

    const samplingFlags = current.flags.filter((flag) => flag.category === "sampling");
    const topLevel = samplingFlags
        .filter((flag) => !hasText(flag.submenu))
        .map((flag) => flag.id);

    assert.deepEqual(
        new Set(topLevel),
        SAMPLING_TOP_LEVEL,
        `sampling top-level flags drifted; got: ${topLevel.join(", ")}`
    );
    assert.equal(
        samplingFlags.length - topLevel.length,
        20,
        "expected 20 sampling flags to be grouped into submenus"
    );
}

assert.deepEqual(validateFlags(null, []), {
    errors: ["FLAGS must be an array."],
    warnings: [],
});

{
    const categories = [{ id: "server", submenuOrder: ["Alpha", "Beta"] }];
    const result = validateFlags(
        [
            makeFlag({ submenu: "Alpha" }),
            makeFlag({ id: "second", flag: "--second", submenu: "Gamma" }),
        ],
        categories
    );
    assertIncludes(result.errors, 'Submenu "Gamma" in category "server" is missing from submenuOrder.');
    assertIncludes(result.errors, 'Category "server" lists unused submenu "Beta" in submenuOrder.');
}

{
    const result = validateFlags(
        [makeFlag({ submenu: "Alpha" })],
        [{ id: "server", submenuOrder: ["Alpha", "Alpha"] }]
    );
    assertIncludes(result.errors, 'Category "server" has duplicate names in submenuOrder.');
}

{
    const result = validateFlags(
        [makeFlag(), makeFlag({ flag: "--second" })],
        [{ id: "server" }]
    );
    assertIncludes(result.errors, 'Duplicate flag id "example" at indexes 0 and 1.');
}

{
    const result = validateFlags(
        [makeFlag(), makeFlag({ id: "second" })],
        [{ id: "server" }]
    );
    assertIncludes(result.warnings, 'CLI flag "--example" is used by both "example" and "second".');
}

{
    const result = validateFlags(
        [makeFlag({ category: "missing", tool: "invalid", type: "unknown" })],
        [{ id: "server" }]
    );
    assertIncludes(result.errors, 'Flag "example" has invalid category "missing".');
    assertIncludes(result.errors, 'Flag "example" has invalid tool "invalid".');
    assertIncludes(result.errors, 'Flag "example" has unsupported type "unknown".');
}

{
    const result = validateFlags(
        [makeFlag({ type: "enum", options: [] })],
        [{ id: "server" }]
    );
    assertIncludes(result.errors, '"example" is enum but has no usable options array.');
    assertIncludes(result.warnings, 'default for "example" is not present in its enum options.');
}

{
    const result = validateFlags(
        [makeFlag({
            type: "enum",
            default: "missing",
            options: [
                { label: "One", value: "one" },
                { label: "", value: "one" },
            ],
        })],
        [{ id: "server" }]
    );
    assertIncludes(result.warnings, '"example" option 1 is missing a readable label.');
    assertIncludes(result.warnings, '"example" has duplicate option value "one".');
    assertIncludes(result.warnings, 'default for "example" is not present in its enum options.');
}

{
    const result = validateFlags(
        [makeFlag({ type: "text", false_flag: "" })],
        [{ id: "server" }]
    );
    assertIncludes(result.errors, 'Flag "example" has false_flag but is not type bool or enum.');
}

{
    const result = validateFlags(
        [makeFlag({ false_flag: "" })],
        [{ id: "server" }]
    );
    assertIncludes(result.errors, 'Flag "example" has an empty false_flag.');
}

{
    const result = validateFlags(
        [makeFlag({ type: "enum", default: "one", options: [null, { label: "Missing value" }] })],
        [{ id: "server" }]
    );
    assertIncludes(result.errors, '"example" option 0 is not an object.');
    assertIncludes(result.errors, '"example" option 1 is missing value.');
}

{
    const result = validateFlags(
        [
            makeFlag({ default: "false" }),
            makeFlag({ id: "count", flag: "--count", type: "int", default: 1.5 }),
            makeFlag({ id: "ratio", flag: "--ratio", type: "float", default: "invalid" }),
            makeFlag({ id: "items", flag: "--items", type: "multi_enum", default: {}, options: [{ label: "One", value: "one" }] }),
        ],
        [{ id: "server" }]
    );
    assertIncludes(result.warnings, 'default for "example" should be boolean for bool flags.');
    assertIncludes(result.warnings, 'default for "count" should be an integer-compatible value.');
    assertIncludes(result.warnings, 'default for "ratio" should be a finite number-compatible value.');
    assertIncludes(result.warnings, 'default for "items" should be an array or comma-separated string for multi_enum flags.');
}

console.log(`flag definition validation passed for ${current.flags.length} GUI flags`);
