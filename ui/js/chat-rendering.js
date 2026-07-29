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
        if (typeof navigator === "undefined") return;
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
        navigator.clipboard.writeText(text).catch((e) => console.debug("Clipboard write failed", e));
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
                copyTextToClipboard(block.code);
                button.textContent = "Copied";
                window.setTimeout(() => {
                    button.textContent = "Copy";
                }, 1200);
            });
        });
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

        const rawText = (details.dataset.rawText || "") + token;
        details.dataset.rawText = rawText;
        updateChatReasoningMeta(details, rawText);
        if (!details.dataset.streamingTextInitialized) {
            body.textContent = rawText;
            details.dataset.streamingTextInitialized = "1";
        } else {
            body.textContent += token;
        }
        const container = document.getElementById("chat-messages");
        if (container) container.scrollTop = container.scrollHeight;
    }

    function finalizeChatReasoningMarkdown(bubble) {
        const details = getChatReasoningBlock(bubble);
        if (!details) return;
        const rawText = details.dataset.rawText || "";
        if (!rawText.trim()) {
            details.remove();
            return;
        }
        setChatReasoningContent(bubble, rawText);
        const container = document.getElementById("chat-messages");
        if (container) container.scrollTop = container.scrollHeight;
    }

    function renderChatMessage(role, content, options = {}) {
        const container = document.getElementById("chat-messages");
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
        if (role === "assistant" && options.reasoning) {
            setChatReasoningContent(bubble, options.reasoning);
        }
        container.scrollTop = container.scrollHeight;
        return bubble;
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
        container.scrollTop = container.scrollHeight;
    }

    function removeChatTypingIndicator() {
        const typing = document.getElementById("chat-typing-msg");
        if (typing) typing.remove();
    }

    function appendChatStreamToken(bubble, token) {
        bubble.dataset.rawText = (bubble.dataset.rawText || "") + token;
        if (!bubble.dataset.streamingTextInitialized) {
            bubble.textContent = bubble.dataset.rawText;
            bubble.dataset.streamingTextInitialized = "1";
        } else {
            bubble.textContent += token;
        }
        const container = document.getElementById("chat-messages");
        container.scrollTop = container.scrollHeight;
    }

    function finalizeChatStreamMarkdown(bubble) {
        if (!bubble) return;
        const rawText = bubble.dataset.rawText || "";
        bubble.innerHTML = renderMarkdown(rawText);
        installChatCodeCopyButtons(bubble, rawText);
        delete bubble.dataset.streamingTextInitialized;
        const container = document.getElementById("chat-messages");
        container.scrollTop = container.scrollHeight;
    }

    window.LlamaGui.chatRendering = {
        renderMarkdown,
        renderChatMessage,
        setChatWebStatus,
        renderChatSources,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
        finalizeChatStreamMarkdown,
        appendChatReasoningStreamToken,
        finalizeChatReasoningMarkdown,
        setChatReasoningContent,
        splitReasoningFromContent,
        installChatCodeCopyButtons,
    };
})();
