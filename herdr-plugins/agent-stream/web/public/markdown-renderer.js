const MARKDOWN_SIGNAL = /(^|\n)(?:#{1,6}\s|```|(?:[-+*]|\d+\.)\s)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_)|\[[^\]\n]+\]\([^)\n]+\)/u;

export function shouldRenderAgentMarkdown(item) {
  return item?.type === "AgentMessage"
    && ["commentary", "final_answer"].includes(item.phase);
}

function inlineNodes(text) {
  const nodes = [];
  const tokenPattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))/gu;
  let position = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > position) nodes.push({ type: "text", value: text.slice(position, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const closeBracket = token.indexOf("](");
      const label = token.slice(1, closeBracket);
      const href = token.slice(closeBracket + 2, -1).trim();
      nodes.push({ type: "link", href, children: inlineNodes(label) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: inlineNodes(token.slice(2, -2)) });
    } else {
      nodes.push({ type: "emphasis", children: inlineNodes(token.slice(1, -1)) });
    }
    position = match.index + token.length;
  }
  if (position < text.length) nodes.push({ type: "text", value: text.slice(position) });
  return nodes;
}

function paragraphLines(lines, startIndex) {
  const paragraph = [];
  let index = startIndex;
  while (index < lines.length
      && lines[index].trim() !== ""
      && !/^```/u.test(lines[index])
      && !/^#{1,6}\s/u.test(lines[index])
      && !/^\s*(?:[-+*]|\d+\.)\s+/u.test(lines[index])) {
    paragraph.push(lines[index]);
    index += 1;
  }
  return { index, text: paragraph.join("\n") };
}

export function markdownBlocks(value) {
  const text = String(value ?? "").replaceAll("\r\n", "\n");
  if (!MARKDOWN_SIGNAL.test(text)) return null;
  const lines = text.split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([a-zA-Z0-9_+-]{0,32})\s*$/u);
    if (fence) {
      const content = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: "codeBlock", language: fence[1] || null, value: content.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: inlineNodes(heading[2]) });
      index += 1;
      continue;
    }
    const listItem = line.match(/^\s*((?:[-+*])|(\d+)\.)\s+(.+)$/u);
    if (listItem) {
      const ordered = Boolean(listItem[2]);
      const items = [];
      while (index < lines.length) {
        const nextItem = lines[index].match(/^\s*((?:[-+*])|(\d+)\.)\s+(.+)$/u);
        if (!nextItem || Boolean(nextItem[2]) !== ordered) break;
        items.push(inlineNodes(nextItem[3]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph = paragraphLines(lines, index);
    blocks.push({ type: "paragraph", lines: paragraph.text.split("\n").map(inlineNodes) });
    index = paragraph.index;
  }
  return blocks;
}

export function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function appendInline(documentValue, parent, nodes) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.append(documentValue.createTextNode(node.value));
    } else if (node.type === "code") {
      const code = documentValue.createElement("code");
      code.className = "markdown-inline-code";
      code.textContent = node.value;
      parent.append(code);
    } else if (node.type === "strong" || node.type === "emphasis") {
      const emphasis = documentValue.createElement(node.type === "strong" ? "strong" : "em");
      appendInline(documentValue, emphasis, node.children);
      parent.append(emphasis);
    } else if (node.type === "link") {
      const href = safeLink(node.href);
      if (!href) {
        appendInline(documentValue, parent, node.children);
        parent.append(documentValue.createTextNode(` (${node.href})`));
        continue;
      }
      const anchor = documentValue.createElement("a");
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      appendInline(documentValue, anchor, node.children);
      parent.append(anchor);
    }
  }
}

export function renderAgentMarkdown(documentValue, item, value) {
  if (!shouldRenderAgentMarkdown(item)) return null;
  const blocks = markdownBlocks(value);
  if (!blocks) return null;
  const container = documentValue.createElement("div");
  container.className = "prose markdown";
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const paragraph = documentValue.createElement("p");
      block.lines.forEach((line, index) => {
        if (index > 0) paragraph.append(documentValue.createElement("br"));
        appendInline(documentValue, paragraph, line);
      });
      container.append(paragraph);
    } else if (block.type === "heading") {
      const heading = documentValue.createElement(`h${Math.min(4, block.level + 1)}`);
      appendInline(documentValue, heading, block.children);
      container.append(heading);
    } else if (block.type === "list") {
      const list = documentValue.createElement(block.ordered ? "ol" : "ul");
      for (const itemNodes of block.items) {
        const listItem = documentValue.createElement("li");
        appendInline(documentValue, listItem, itemNodes);
        list.append(listItem);
      }
      container.append(list);
    } else if (block.type === "codeBlock") {
      const pre = documentValue.createElement("pre");
      pre.className = "markdown-code-block";
      const code = documentValue.createElement("code");
      if (block.language) code.dataset.language = block.language;
      code.textContent = block.value;
      pre.append(code);
      container.append(pre);
    }
  }
  return container;
}
