import type { Meeting, NoteLine } from "@/lib/demo-data";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/** Build the TipTap document. One note line maps to exactly one top-level block. */
export function noteLinesToHtml(lines: NoteLine[]): string {
  return lines
    .map((line) => {
      const text = inlineMarkdown(line.text);
      switch (line.kind) {
        case "heading":
          return `<h2>${text}</h2>`;
        case "decision":
          return `<blockquote><p><strong>Decision</strong> ${text}</p></blockquote>`;
        case "todo":
          return `<p><strong>TODO</strong> <span>${text}</span></p>`;
        case "bookmark":
          return `<p><strong>Bookmark</strong> ${text}</p>`;
        default:
          return `<p>${text}</p>`;
      }
    })
    .join("");
}

export function meetingNotesMarkdown(meeting: Meeting): string {
  const lines = meeting.notes.map((note) => {
    const stamp = new Date(note.startMs).toISOString().slice(11, 19);
    return `- **${stamp}** — ${note.text}`;
  });
  return [`# ${meeting.title}`, "", ...lines].join("\n");
}

function inlineNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";

  const inner = Array.from(node.childNodes).map(inlineNodeToMarkdown).join("");
  switch (node.tagName.toLowerCase()) {
    case "strong":
    case "b":
      return `**${inner}**`;
    case "em":
    case "i":
      return `*${inner}*`;
    case "code":
      return `\`${inner}\``;
    case "br":
      return "\n";
    case "a":
      return `[${inner}](${node.getAttribute("href") ?? ""})`;
    default:
      return inner;
  }
}

function blockNodeToMarkdown(node: Node): string {
  if (!(node instanceof HTMLElement)) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ?? "";
    return "";
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${node.textContent ?? ""}`.trimEnd();
  }
  if (tag === "ul" || tag === "ol") {
    return Array.from(node.children)
      .map((child, index) => {
        const prefix = tag === "ol" ? `${index + 1}.` : "-";
        const content = Array.from(child.childNodes).map(inlineNodeToMarkdown).join("").trim();
        return `${prefix} ${content}`;
      })
      .join("\n");
  }
  if (tag === "blockquote") {
    const inner = Array.from(node.childNodes)
      .map((child) => blockNodeToMarkdown(child))
      .join("\n")
      .trim();
    return inner
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (tag === "hr") return "---";
  if (tag === "pre") return `\`\`\`\n${node.textContent ?? ""}\n\`\`\``;
  return Array.from(node.childNodes).map(inlineNodeToMarkdown).join("").trim();
}

/** DOM-based HTML → Markdown conversion used when switching the notes buffer. */
export function htmlToMarkdown(html: string): string {
  if (typeof window === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  if (!root) return "";
  const blocks = Array.from(root.childNodes)
    .map((node) => blockNodeToMarkdown(node).trim())
    .filter(Boolean);
  return blocks.join("\n\n");
}

/**
 * Small Markdown parser covering the note-block grammar: headings, paragraphs,
 * bullets, ordered lists, blockquotes, bold/italic/code and rules.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      output.push(
        `<${tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`,
      );
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      output.push(`<blockquote><p>${inlineMarkdown(quote.join(" "))}</p></blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushAll();
      const level = headingMatch[1].length;
      output.push(`<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushAll();
      output.push("<hr />");
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }
    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    const orderedMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (bulletMatch || orderedMatch) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(orderedMatch);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bulletMatch?.[1] ?? orderedMatch?.[1] ?? "").trim());
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flushAll();
  return output.join("");
}
