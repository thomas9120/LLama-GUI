const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "hf-download-ui.js"), "utf8");

function createClassList(el) {
    return {
        add: (...names) => {
            for (const name of names) el._classes.add(name);
        },
        remove: (...names) => {
            for (const name of names) el._classes.delete(name);
        },
        contains: (name) => el._classes.has(name),
        toggle: (name, force) => {
            const shouldAdd = force === undefined ? !el._classes.has(name) : !!force;
            if (shouldAdd) el._classes.add(name);
            else el._classes.delete(name);
            return shouldAdd;
        },
    };
}

function createElement(tagName = "div") {
    return {
        tagName: tagName.toUpperCase(),
        children: [],
        _classes: new Set(),
        className: "",
        textContent: "",
        value: "",
        disabled: false,
        style: {},
        addEventListener: () => {},
        appendChild(child) {
            this.children.push(child);
            if (this.tagName === "SELECT" && !this.value && child.value !== undefined) {
                this.value = child.value;
            }
            return child;
        },
        get options() {
            return this.children;
        },
        set innerHTML(_value) {
            this.children = [];
            this.value = "";
        },
        get innerHTML() {
            return "";
        },
    };
}

function makeContext() {
    const elements = new Map();
    const context = {
        window: { LlamaGui: {} },
        document: {
            createElement,
            getElementById: (id) => elements.get(id) || null,
        },
        console,
        setInterval: () => 1,
        clearInterval: () => {},
        Date,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "ui/js/hf-download-ui.js" });
    return { context, elements, ui: context.window.LlamaGui.hfDownloadUi };
}

function addElement(elements, id, tagName = "div", value = "") {
    const el = createElement(tagName);
    el.id = id;
    el.value = value;
    el.classList = createClassList(el);
    elements.set(id, el);
    return el;
}

(async () => {
{
    const { elements, ui } = makeContext();
    const status = addElement(elements, "hf-download-status");
    const findBtn = addElement(elements, "btn-hf-find-files", "button");
    const downloadBtn = addElement(elements, "btn-hf-download", "button");
    const cancelBtn = addElement(elements, "btn-hf-cancel", "button");
    const progress = addElement(elements, "hf-download-progress");
    const fill = addElement(elements, "hf-progress-fill");
    const text = addElement(elements, "hf-progress-text");

    assert.equal(ui.formatHfBytes(0), "unknown size");
    assert.equal(ui.formatHfBytes(1048576), "1.0 MB");
    assert.equal(ui.formatHfBytes(2147483648), "2.00 GB");

    ui.showStatus("success", "Ready");
    assert.equal(status.className, "hf-download-status success");
    assert.equal(status.textContent, "Ready");

    ui.setBusy(true);
    assert.equal(findBtn.disabled, true);
    assert.equal(downloadBtn.disabled, true);
    assert.equal(cancelBtn.classList.contains("hidden"), false);
    ui.setBusy(false);
    assert.equal(findBtn.disabled, false);
    assert.equal(downloadBtn.disabled, false);
    assert.equal(cancelBtn.classList.contains("hidden"), true);

    ui.updateProgress({ status: "downloading", downloaded: 1048576, total: 2097152, current_file: "model.gguf" });
    assert.equal(progress.classList.contains("hidden"), false);
    assert.equal(fill.style.width, "50%");
    assert.equal(text.textContent, "model.gguf 50% (1.0 MB / 2.0 MB)");
}

{
    const { elements, ui } = makeContext();
    addElement(elements, "hf-download-status");
    addElement(elements, "btn-hf-find-files", "button");
    addElement(elements, "btn-hf-download", "button");
    addElement(elements, "btn-hf-cancel", "button");
    const repo = addElement(elements, "hf-repo-input", "input", " owner/model ");
    const revision = addElement(elements, "hf-revision-input", "input", " refs/pr/1 ");
    const token = addElement(elements, "hf-token-input", "input", " hf_secret ");
    const options = addElement(elements, "hf-file-options");
    const modelSelect = addElement(elements, "hf-model-file-select", "select");
    const mmprojSelect = addElement(elements, "hf-mmproj-file-select", "select");
    const mmprojGroup = addElement(elements, "hf-mmproj-group");
    options.classList.add("hidden");
    mmprojGroup.classList.add("hidden");

    const calls = [];
    ui.configure({
        fetchJson: async (url, optionsArg) => {
            calls.push({ url, body: JSON.parse(optionsArg.body) });
            return {
                models: [{ name: "model.Q4.gguf", size: 1048576 }],
                mmproj: [{ name: "mmproj.gguf", size: 524288 }],
            };
        },
    });

    await ui.findFiles();
    assert.equal(calls[0].url, "/api/hf/repo-files");
    assert.deepEqual(calls[0].body, {
        repo_id: "owner/model",
        revision: "refs/pr/1",
        token: "hf_secret",
    });
    assert.equal(modelSelect.options.length, 2);
    assert.equal(modelSelect.options[1].textContent, "model.Q4.gguf  (1.0 MB)");
    assert.equal(modelSelect.value, "model.Q4.gguf");
    assert.equal(mmprojSelect.options[1].value, "mmproj.gguf");
    assert.equal(options.classList.contains("hidden"), false);
    assert.equal(mmprojGroup.classList.contains("hidden"), false);
    assert.equal(repo.value, " owner/model ");
    assert.equal(revision.value, " refs/pr/1 ");
    assert.equal(token.value, " hf_secret ");
}

{
    const { elements, ui } = makeContext();
    const status = addElement(elements, "hf-download-status");
    addElement(elements, "btn-hf-find-files", "button");
    addElement(elements, "btn-hf-download", "button");
    addElement(elements, "btn-hf-cancel", "button");
    const options = addElement(elements, "hf-file-options");
    addElement(elements, "hf-repo-input", "input", "owner/model");
    addElement(elements, "hf-revision-input", "input", "");
    addElement(elements, "hf-token-input", "input", "");
    addElement(elements, "hf-model-file-select", "select");
    addElement(elements, "hf-mmproj-file-select", "select");
    options.classList.remove("hidden");

    ui.configure({
        fetchJson: async () => {
            throw new Error("network down");
        },
    });

    await ui.findFiles();
    assert.equal(options.classList.contains("hidden"), true);
    assert.equal(status.className, "hf-download-status error");
    assert.equal(status.textContent, "Hugging Face lookup failed: network down");
}

{
    const { elements, ui } = makeContext();
    addElement(elements, "hf-download-status");
    addElement(elements, "btn-hf-find-files", "button");
    addElement(elements, "btn-hf-download", "button");
    addElement(elements, "btn-hf-cancel", "button");
    addElement(elements, "hf-repo-input", "input", "owner/model");
    addElement(elements, "hf-revision-input", "input", "");
    addElement(elements, "hf-token-input", "input", "");
    addElement(elements, "hf-model-file-select", "select", "model.gguf");
    addElement(elements, "hf-mmproj-file-select", "select", "mmproj.gguf");

    const calls = [];
    const confirmations = [];
    ui.configure({
        fetchJson: async (url, optionsArg) => {
            calls.push({ url, body: JSON.parse(optionsArg.body) });
            if (!calls.at(-1).body.overwrite) throw new Error("Already exists: model.gguf");
            return { status: "starting" };
        },
        confirmAction: async (message) => {
            confirmations.push(message);
            return true;
        },
    });

    await ui.startDownload(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /Already exists: model\.gguf/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.overwrite, false);
    assert.equal(calls[1].body.overwrite, true);
}

{
    const { elements, ui } = makeContext();
    const status = addElement(elements, "hf-download-status");
    addElement(elements, "btn-hf-find-files", "button");
    addElement(elements, "btn-hf-download", "button");
    addElement(elements, "btn-hf-cancel", "button");

    const calls = [];
    ui.configure({
        refreshModels: async () => calls.push("refreshModels"),
        applyPresetModel: (name) => calls.push(["applyPresetModel", name]),
        refreshQuickLaunchUI: () => calls.push("refreshQuickLaunchUI"),
        flagCore: {
            setPathFlagValue: (id, value) => calls.push(["setPathFlagValue", id, value]),
            updateCommandPreview: () => calls.push("updateCommandPreview"),
        },
    });

    await ui.finishDownload({
        message: "Done",
        model_name: "downloaded.gguf",
        mmproj_path: "models/mmproj.gguf",
    });

    assert.equal(status.className, "hf-download-status success");
    assert.deepEqual(calls, [
        "refreshModels",
        ["applyPresetModel", "downloaded.gguf"],
        ["setPathFlagValue", "mmproj", "models/mmproj.gguf"],
        "updateCommandPreview",
        "refreshQuickLaunchUI",
    ]);
}

console.log("hf download ui unit tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
