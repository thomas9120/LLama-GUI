// Chat rendering: markdown and low-level chat DOM rendering helpers.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    function escapeHtml(text) {
        return String(text ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function getFencedCodeBlocks(text) {
        const codeBlocks = [];
        const withPlaceholders = String(text ?? "").replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, rawLang, rawCode) => {
            const index = codeBlocks.length;
            const lang = String(rawLang || "").trim().split(/\s+/)[0].replace(/[^\w#+.-]/g, "").slice(0, 32);
            codeBlocks.push({
                lang,
                code: String(rawCode || "").replace(/\n$/, ""),
            });
            return `\u0000CODE_BLOCK_${index}\u0000`;
        });
        return { text: withPlaceholders, codeBlocks };
    }

    function renderCodeBlock(block, index) {
        const lang = block.lang || "";
        const label = lang || "Code";
        const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
        return [
            `<div class="chat-code-block" data-code-index="${index}">`,
            '<div class="chat-code-header">',
            `<span class="chat-code-lang">${escapeHtml(label)}</span>`,
            `<button class="chat-code-copy" type="button" data-code-index="${index}" title="Copy code">Copy</button>`,
            "</div>",
            `<pre${langAttr}><code>${escapeHtml(block.code)}</code></pre>`,
            "</div>",
        ].join("");
    }

    function processBlocks(text) {
        const lines = text.split("\n");
        const blocks = [];
        let i = 0;

        function applyInline(s) {
            s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
            s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
            s = s.replace(/(?<!\w)\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\w)/g, "<em>$1</em>");
            s = s.replace(/(?<!\w)_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g, "<em>$1</em>");
            s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
            s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
            return s;
        }

        while (i < lines.length) {
            const line = lines[i];

            // Horizontal rule
            if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                blocks.push("<hr>");
                i++;
                continue;
            }

            // Headings
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                blocks.push(`<h${level}>${applyInline(headingMatch[2])}</h${level}>`);
                i++;
                continue;
            }

            // Blockquote
            if (/^&gt;\s?/.test(line)) {
                const quoteLines = [];
                while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
                    quoteLines.push(lines[i].replace(/^&gt;\s?/, ""));
                    i++;
                }
                const inner = applyInline(quoteLines.join("\n"));
                blocks.push(`<blockquote><p>${inner.replace(/\n/g, "<br>")}</p></blockquote>`);
                continue;
            }

            // Table
            if (line.includes("|") && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
                const tableLines = [];
                while (i < lines.length && lines[i].includes("|")) {
                    tableLines.push(lines[i]);
                    i++;
                }
                if (tableLines.length >= 2) {
                    const parseRow = (row) => row.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
                    const headers = parseRow(tableLines[0]);
                    let tbl = "<table><thead><tr>";
                    for (const h of headers) tbl += `<th>${applyInline(h)}</th>`;
                    tbl += "</tr></thead><tbody>";
                    for (let r = 2; r < tableLines.length; r++) {
                        const cells = parseRow(tableLines[r]);
                        tbl += "<tr>";
                        for (const c of cells) tbl += `<td>${applyInline(c)}</td>`;
                        tbl += "</tr>";
                    }
                    tbl += "</tbody></table>";
                    blocks.push(tbl);
                }
                continue;
            }

            // Unordered list
            if (/^[\s]*[-*+]\s+/.test(line)) {
                const listItems = [];
                while (i < lines.length && /^[\s]*[-*+]\s+/.test(lines[i])) {
                    listItems.push(lines[i].replace(/^[\s]*[-*+]\s+/, ""));
                    i++;
                }
                let ul = "<ul>";
                for (const item of listItems) ul += `<li>${applyInline(item)}</li>`;
                ul += "</ul>";
                blocks.push(ul);
                continue;
            }

            // Ordered list
            if (/^[\s]*\d+\.\s+/.test(line)) {
                const listItems = [];
                while (i < lines.length && /^[\s]*\d+\.\s+/.test(lines[i])) {
                    listItems.push(lines[i].replace(/^[\s]*\d+\.\s+/, ""));
                    i++;
                }
                let ol = "<ol>";
                for (const item of listItems) ol += `<li>${applyInline(item)}</li>`;
                ol += "</ol>";
                blocks.push(ol);
                continue;
            }

            // Code block placeholder (already extracted)
            if (/^\u0000CODE_BLOCK_\d+\u0000$/.test(line)) {
                blocks.push(line);
                i++;
                continue;
            }

            // Regular text: collect contiguous lines into a paragraph
            const paraLines = [];
            while (i < lines.length &&
                !/^(#{1,6}\s|[\s]*[-*+]\s|[\s]*\d+\.\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i]) &&
                !/^&gt;\s?/.test(lines[i]) &&
                !(lines[i].includes("|") && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) &&
                !/^\u0000CODE_BLOCK_\d+\u0000$/.test(lines[i])) {
                paraLines.push(lines[i]);
                i++;
            }
            if (paraLines.length > 0) {
                const content = paraLines.join("<br>");
                if (content.trim()) blocks.push(`<p>${applyInline(content)}</p>`);
            }
        }

        return blocks.join("\n");
    }

    function renderMarkdown(text) {
        const extracted = getFencedCodeBlocks(text);
        let html = escapeHtml(extracted.text);

        // Block-level and inline processing
        html = processBlocks(html);

        // Restore code blocks
        html = html.replace(/\u0000CODE_BLOCK_(\d+)\u0000/g, (_, index) => {
            const blockIndex = Number(index);
            const block = extracted.codeBlocks[blockIndex];
            return block ? renderCodeBlock(block, blockIndex) : "";
        });

        return html;
    }

    function splitReasoningFromContent(content) {
        let remaining = String(content ?? "");
        const reasoningParts = [];
        const leadingThinkBlock = /^\s*<think(?:\s[^>]*)?>([\s\S]*?)<\/think>\s*/i;

        while (true) {
            const match = remaining.match(leadingThinkBlock);
            if (!match) break;
            reasoningParts.push(match[1].trim());
            remaining = remaining.slice(match[0].length);
        }

        return {
            content: reasoningParts.length ? remaining.trimStart() : remaining,
            reasoning: reasoningParts.filter(Boolean).join("\n\n"),
        };
    }

    function copyTextToClipboard(text) {
        if (typeof navigator === "undefined"
            || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
            return Promise.resolve(false);
        }
        try {
            return Promise.resolve(navigator.clipboard.writeText(String(text ?? "")))
                .then(() => true)
                .catch((e) => {
                    console.warn("Clipboard write failed", e);
                    return false;
                });
        } catch (e) {
            console.warn("Clipboard write failed", e);
            return Promise.resolve(false);
        }
    }

    function resolveChatMessagesContainer(container) {
        if (container && typeof container === "object") return container;
        return document.getElementById(container || "chat-messages");
    }

    function isChatNearBottom(container, threshold = 80) {
        const target = resolveChatMessagesContainer(container);
        if (!target) return true;
        const scrollHeight = Number(target.scrollHeight);
        const clientHeight = Number(target.clientHeight);
        const scrollTop = Number(target.scrollTop);
        // Detached test fixtures and a newly laid out empty transcript have no
        // useful geometry yet; follow their first render by default.
        if (![scrollHeight, clientHeight, scrollTop].every(Number.isFinite)) return true;
        if (scrollHeight <= clientHeight) return true;
        return scrollHeight - (scrollTop + clientHeight) <= Math.max(0, Number(threshold) || 0);
    }

    function scrollChatToLatest(container) {
        const target = resolveChatMessagesContainer(container);
        if (!target) return false;
        const scrollHeight = Number(target.scrollHeight);
        if (Number.isFinite(scrollHeight)) target.scrollTop = scrollHeight;
        return true;
    }

    function followChatIfNearBottom(container, threshold = 80) {
        const target = resolveChatMessagesContainer(container);
        if (!target || !isChatNearBottom(target, threshold)) return false;
        scrollChatToLatest(target);
        return true;
    }

    function installChatCodeCopyButtons(bubble, rawText) {
        if (!bubble || typeof bubble.querySelectorAll !== "function") return;
        const { codeBlocks } = getFencedCodeBlocks(rawText);
        bubble.querySelectorAll(".chat-code-copy").forEach((button) => {
            const index = Number(button.dataset.codeIndex);
            const block = Number.isInteger(index) ? codeBlocks[index] : null;
            if (!block) return;
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!button.textContent) button.textContent = "Copy";
                void copyTextToClipboard(block.code).then((copied) => {
                    button.textContent = copied ? "Copied" : "Copy failed";
                    window.setTimeout(() => {
                        button.textContent = "Copy";
                    }, 1200);
                });
            });
        });
    }

    function getChatResponseRawText(bubble) {
        if (!bubble) return "";
        if (bubble.dataset && bubble.dataset.rawText !== undefined) return String(bubble.dataset.rawText);
        return String(bubble.textContent || "");
    }

    function updateChatResponseCopyButton(bubble) {
        const wrap = getChatMessageContentWrap(bubble);
        const button = wrap ? wrap.querySelector(".chat-response-copy") : null;
        if (!button) return;
        button.disabled = !getChatResponseRawText(bubble).trim();
    }

    function installChatResponseCopyButton(bubble) {
        const wrap = getChatMessageContentWrap(bubble);
        if (!wrap || wrap.querySelector(".chat-response-copy")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-xs chat-response-copy";
        const copyIcon = '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
        const showIcon = (label, paths) => {
            button.title = label;
            button.setAttribute("aria-label", label);
            button.innerHTML = `<span class="icon icon-sm" aria-hidden="true"><svg viewBox="0 0 24 24">${paths}</svg></span>`;
        };
        showIcon("Copy response", copyIcon);
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = getChatResponseRawText(bubble);
            if (!text.trim()) return;
            void copyTextToClipboard(text).then((copied) => {
                showIcon(copied ? "Response copied" : "Copy failed", copied
                    ? '<polyline points="20 6 9 17 4 12"/>' : '<path d="m18 6-12 12M6 6l12 12"/>');
                window.setTimeout(() => {
                    showIcon("Copy response", copyIcon);
                }, 1200);
            });
        });
        wrap.appendChild(button);
        updateChatResponseCopyButton(bubble);
    }

    function getChatMessageContentWrap(bubble) {
        return bubble ? bubble.closest(".chat-message-content") : null;
    }

    function getChatReasoningBlock(bubble) {
        const wrap = getChatMessageContentWrap(bubble);
        return wrap ? wrap.querySelector(".chat-reasoning") : null;
    }

    function createChatReasoningBlock() {
        const details = document.createElement("details");
        details.className = "chat-reasoning";

        const summary = document.createElement("summary");
        summary.className = "chat-reasoning-summary";

        const title = document.createElement("span");
        title.className = "chat-reasoning-title";
        title.textContent = "Thinking";

        const meta = document.createElement("span");
        meta.className = "chat-reasoning-meta";

        summary.appendChild(title);
        summary.appendChild(meta);

        const body = document.createElement("div");
        body.className = "chat-reasoning-body";

        details.appendChild(summary);
        details.appendChild(body);
        return details;
    }

    function updateChatReasoningMeta(details, text) {
        const meta = details ? details.querySelector(".chat-reasoning-meta") : null;
        if (!meta) return;
        const trimmed = String(text || "").trim();
        meta.textContent = trimmed ? `${trimmed.length.toLocaleString()} chars` : "";
    }

    function ensureChatReasoningBlock(bubble) {
        let details = getChatReasoningBlock(bubble);
        if (details) return details;

        const wrap = getChatMessageContentWrap(bubble);
        if (!wrap) return null;
        details = createChatReasoningBlock();
        if (typeof wrap.insertBefore === "function") {
            wrap.insertBefore(details, bubble);
        } else {
            wrap.appendChild(details);
        }
        return details;
    }

    function setChatReasoningContent(bubble, reasoning, options = {}) {
        const text = String(reasoning ?? "");
        if (!bubble || !text.trim()) return null;

        const details = ensureChatReasoningBlock(bubble);
        if (!details) return null;
        const body = details.querySelector(".chat-reasoning-body");
        if (!body) return details;

        details.dataset.rawText = text;
        updateChatReasoningMeta(details, text);
        if (options.streaming) {
            body.textContent = text;
            details.dataset.streamingTextInitialized = "1";
        } else {
            body.innerHTML = renderMarkdown(text);
            installChatCodeCopyButtons(body, text);
            delete details.dataset.streamingTextInitialized;
        }
        return details;
    }

    function appendChatReasoningStreamToken(bubble, token) {
        const details = ensureChatReasoningBlock(bubble);
        if (!details) return;
        const body = details.querySelector(".chat-reasoning-body");
        if (!body) return;

        const container = document.getElementById("chat-messages");
        const shouldFollow = isChatNearBottom(container);

        const rawText = (details.dataset.rawText || "") + token;
        details.dataset.rawText = rawText;
        updateChatReasoningMeta(details, rawText);
        if (!details.dataset.streamingTextInitialized) {
            body.textContent = rawText;
            details.dataset.streamingTextInitialized = "1";
        } else {
            body.textContent += token;
        }
        if (shouldFollow) scrollChatToLatest(container);
    }

    function renderChatMessage(role, content, options = {}) {
        const container = document.getElementById("chat-messages");
        const shouldFollow = isChatNearBottom(container);
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "none";

        const msg = document.createElement("div");
        msg.className = `chat-message ${role}`;

        const avatar = document.createElement("div");
        avatar.className = "chat-avatar";
        avatar.textContent = role === "user" ? "U" : "A";

        const bubble = document.createElement("div");
        bubble.className = "chat-bubble";
        if (role === "assistant") {
            bubble.innerHTML = renderMarkdown(content);
            bubble.dataset.rawText = content;
            installChatCodeCopyButtons(bubble, content);
        } else {
            bubble.textContent = content;
        }

        msg.appendChild(avatar);
        const contentWrap = document.createElement("div");
        contentWrap.className = "chat-message-content";
        contentWrap.appendChild(bubble);
        msg.appendChild(contentWrap);
        container.appendChild(msg);
        if (role === "assistant") installChatResponseCopyButton(bubble);
        if (role === "assistant" && options.reasoning) {
            setChatReasoningContent(bubble, options.reasoning);
        }
        if (role === "assistant" && options.metadata) setChatResponseMetadata(bubble, options.metadata);
        if (shouldFollow) scrollChatToLatest(container);
        return bubble;
    }

    function getResponseMetadataValue(source, keys) {
        for (const key of keys) {
            const value = source && source[key];
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return undefined;
    }

    function formatResponseNumber(value, suffix = "") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return String(value) + suffix;
        return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
    }

    function formatStopReason(value) {
        const normalized = String(value || "").trim().toLowerCase();
        const labels = {
            stop: "Finished",
            length: "Output limit reached",
            content_filter: "Filtered",
            tool_calls: "Tool call",
            function_call: "Function call",
        };
        if (labels[normalized]) return labels[normalized];
        return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
    }

    function setChatResponseMetadata(bubble, metadata) {
        const wrap = getChatMessageContentWrap(bubble);
        if (!wrap) return null;
        const previous = wrap.querySelector(".chat-response-metadata");
        if (previous) previous.remove();

        const source = metadata && typeof metadata === "object" ? metadata : null;
        if (!source) return null;
        const usage = source.usage && typeof source.usage === "object" ? source.usage : null;
        const promptTokens = getResponseMetadataValue(source, ["prompt_tokens", "promptTokens"])
            ?? getResponseMetadataValue(usage, ["prompt_tokens", "promptTokens"]);
        const completionTokens = getResponseMetadataValue(source, ["completion_tokens", "completionTokens"])
            ?? getResponseMetadataValue(usage, ["completion_tokens", "completionTokens"]);
        const totalTokens = getResponseMetadataValue(source, ["total_tokens", "totalTokens"])
            ?? getResponseMetadataValue(usage, ["total_tokens", "totalTokens"]);
        const speed = getResponseMetadataValue(source, [
            "tokens_per_second", "tokensPerSecond", "completion_tokens_per_second",
            "completionTokensPerSecond", "predicted_per_second",
        ]) ?? getResponseMetadataValue(source.timings, ["predicted_per_second", "predictedPerSecond"]);
        const stopReason = getResponseMetadataValue(source, ["stop_reason", "stopReason", "finish_reason", "finishReason"]);
        const fields = [];
        if (promptTokens !== undefined) fields.push(["Prompt", formatResponseNumber(promptTokens)]);
        if (completionTokens !== undefined) fields.push(["Completion", formatResponseNumber(completionTokens)]);
        if (totalTokens !== undefined) fields.push(["Total", formatResponseNumber(totalTokens)]);
        if (speed !== undefined) fields.push(["Speed", formatResponseNumber(speed, " tok/s")]);
        if (stopReason !== undefined) fields.push(["Stop", formatStopReason(stopReason)]);
        if (fields.length === 0) return null;

        const footer = document.createElement("div");
        footer.className = "chat-response-metadata";
        footer.setAttribute("role", "status");
        footer.setAttribute("aria-label", "Response details");
        for (const [label, value] of fields) {
            const item = document.createElement("span");
            item.className = "chat-response-metadata-item";
            item.textContent = `${label}: ${value}`;
            footer.appendChild(item);
        }
        wrap.appendChild(footer);
        return footer;
    }

    function setChatWebStatus(bubble, text) {
        const wrap = getChatMessageContentWrap(bubble);
        if (!wrap) return;
        let status = wrap.querySelector(".chat-web-status");
        if (!text) {
            if (status) status.remove();
            return;
        }
        if (!status) {
            status = document.createElement("div");
            status.className = "chat-web-status";
            wrap.appendChild(status);
        }
        status.textContent = text;
    }

    function renderChatSources(bubble, sources) {
        const wrap = getChatMessageContentWrap(bubble);
        if (!wrap || !Array.isArray(sources) || sources.length === 0) return;
        const existing = wrap.querySelector(".chat-sources");
        if (existing) existing.remove();
        const sourceWrap = document.createElement("div");
        sourceWrap.className = "chat-sources";

        for (const source of sources) {
            const safeUrl = getSafeExternalUrl(source.url);
            const chip = document.createElement(safeUrl ? "a" : "span");
            chip.className = "chat-source-chip";
            if (safeUrl) {
                chip.href = safeUrl;
                chip.target = "_blank";
                chip.rel = "noopener noreferrer";
            }
            const title = source.title || source.url || "Source";
            chip.title = source.url || title;
            chip.textContent = `[${source.index || sourceWrap.children.length + 1}] ${title}`;
            sourceWrap.appendChild(chip);
        }

        wrap.appendChild(sourceWrap);
    }

    function getSafeExternalUrl(url) {
        try {
            const parsed = new URL(String(url || ""));
            return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
        } catch (e) {
            console.debug("Ignored invalid chat source URL", e);
            return "";
        }
    }

    function renderChatTypingIndicator() {
        const container = document.getElementById("chat-messages");
        const shouldFollow = isChatNearBottom(container);
        const msg = document.createElement("div");
        msg.className = "chat-message assistant";
        msg.id = "chat-typing-msg";

        const avatar = document.createElement("div");
        avatar.className = "chat-avatar";
        avatar.textContent = "A";

        const typing = document.createElement("div");
        typing.className = "chat-typing";
        typing.id = "chat-typing";
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement("span");
            dot.className = "chat-typing-dot";
            typing.appendChild(dot);
        }

        msg.appendChild(avatar);
        msg.appendChild(typing);
        container.appendChild(msg);
        if (shouldFollow) scrollChatToLatest(container);
    }

    function removeChatTypingIndicator() {
        const typing = document.getElementById("chat-typing-msg");
        if (typing) typing.remove();
    }

    function appendChatStreamToken(bubble, token) {
        const container = document.getElementById("chat-messages");
        const shouldFollow = isChatNearBottom(container);
        bubble.dataset.rawText = (bubble.dataset.rawText || "") + token;
        if (!bubble.dataset.streamingTextInitialized) {
            bubble.textContent = bubble.dataset.rawText;
            bubble.dataset.streamingTextInitialized = "1";
        } else {
            bubble.textContent += token;
        }
        updateChatResponseCopyButton(bubble);
        if (shouldFollow) scrollChatToLatest(container);
    }

    window.LlamaGui.chatRendering = {
        renderMarkdown,
        renderChatMessage,
        setChatWebStatus,
        renderChatSources,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
        appendChatReasoningStreamToken,
        setChatReasoningContent,
        splitReasoningFromContent,
        installChatCodeCopyButtons,
        installChatResponseCopyButton,
        setChatResponseMetadata,
        isChatNearBottom,
        scrollChatToLatest,
        followChatIfNearBottom,
    };
})();
