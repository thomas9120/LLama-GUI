(function () {
    window.LlamaGui = window.LlamaGui || {};

    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
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
        let html = escapeHtml(text);
        const codeBlocks = [];

        // Fenced code blocks ``` ... ```
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const langAttr = lang ? ` data-lang="${lang}"` : "";
            const index = codeBlocks.length;
            codeBlocks.push(`<pre${langAttr}><code>${code.replace(/\n$/, "")}</code></pre>`);
            return `\u0000CODE_BLOCK_${index}\u0000`;
        });

        // Block-level and inline processing
        html = processBlocks(html);

        // Restore code blocks
        html = html.replace(/\u0000CODE_BLOCK_(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)] || "");

        return html;
    }

    function renderChatMessage(role, content) {
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
        } else {
            bubble.textContent = content;
        }

        msg.appendChild(avatar);
        const contentWrap = document.createElement("div");
        contentWrap.className = "chat-message-content";
        contentWrap.appendChild(bubble);
        msg.appendChild(contentWrap);
        container.appendChild(msg);
        container.scrollTop = container.scrollHeight;
        return bubble;
    }

    function getChatMessageContentWrap(bubble) {
        return bubble ? bubble.closest(".chat-message-content") : null;
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
        } catch {
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
        bubble.innerHTML = renderMarkdown(bubble.dataset.rawText);
        const container = document.getElementById("chat-messages");
        container.scrollTop = container.scrollHeight;
    }

    window.LlamaGui.chatRendering = {
        escapeHtml,
        processBlocks,
        renderMarkdown,
        renderChatMessage,
        getChatMessageContentWrap,
        setChatWebStatus,
        renderChatSources,
        getSafeExternalUrl,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
    };
})();
