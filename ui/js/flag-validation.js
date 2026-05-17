(function () {
    const root = window.LlamaGui = window.LlamaGui || {};
    const SUPPORTED_TOOLS = new Set(["server", "cli", "both"]);
    const SUPPORTED_TYPES = new Set(["bool", "int", "float", "text", "path", "enum", "multi_enum"]);

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
        } else if (flag.type === "enum") {
            const options = Array.isArray(flag.options) ? flag.options : [];
            const optionValues = new Set(options.map((opt) => String(opt && opt.value)));
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

    function validateFlags(flags, categories) {
        const errors = [];
        const warnings = [];
        const categoryIds = new Set((categories || []).map((category) => category && category.id).filter(Boolean));
        const flagIds = new Map();
        const cliFlags = new Map();

        function addError(message) {
            errors.push(message);
        }

        function addWarning(message) {
            warnings.push(message);
        }

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
                if (flag.type !== "bool") {
                    addError(`Flag ${label} has false_flag but is not type bool.`);
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

        for (const catId of categoryIds) {
            if (flagIds.has(catId)) {
                addWarning(`Category id "${catId}" collides with flag id "${catId}".`);
            }
        }

        return { errors, warnings };
    }

    function reportValidationResult(result) {
        if (!result || (!result.errors.length && !result.warnings.length)) {
            console.info("[flag-validation] FLAGS passed validation.");
            return;
        }

        console.groupCollapsed(
            `[flag-validation] FLAGS validation found ${result.errors.length} error(s), ${result.warnings.length} warning(s).`
        );
        for (const error of result.errors) console.error(error);
        for (const warning of result.warnings) console.warn(warning);
        console.groupEnd();
    }

    function runFlagValidation() {
        const result = validateFlags(window.FLAGS || FLAGS, window.FLAG_CATEGORIES || FLAG_CATEGORIES);
        reportValidationResult(result);
        return result;
    }

    root.flagValidation = {
        validateFlags,
        runFlagValidation,
    };

    runFlagValidation();
})();
