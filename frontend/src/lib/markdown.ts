import type { Meeting, NoteLine } from "@/lib/demo-data";
import type { NewNoteBlockInput } from "@/lib/host";

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

export function parseTimestampToMs(stamp: string | undefined | null): number | null {
  if (!stamp) return null;
  const parts = stamp
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  return null;
}

/** Build the TipTap document. One note line maps to exactly one top-level block. */
export function noteLinesToHtml(lines: NoteLine[]): string {
  if (lines.length === 0) return "<p></p>";
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
  if (meeting.manualNotesRawMd && meeting.manualNotesRawMd.trim().length > 0) {
    return meeting.manualNotesRawMd;
  }
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

function inferBlockTypeFromMarkdown(mdLine: string): string {
  const trimmed = mdLine.trim();
  if (/^#{1,3}\s+/.test(trimmed)) return "heading";
  if (/^(?:>\s*)?(?:\*\*)?decision\b/i.test(trimmed)) return "decision";
  if (/^(?:\*\*)?todo\b/i.test(trimmed)) return "todo";
  if (/^(?:\*\*)?bookmark\b/i.test(trimmed)) return "bookmark";
  if (/^```/.test(trimmed)) return "code";
  return "paragraph";
}

/**
 * Extract structured `NewNoteBlockInput[]` + `rawMd` from live ProseMirror DOM
 * children while preserving each block's gutter `data-timestamp` offset.
 */
export function serializeRichEditorToNotePayload(
  editorDom: HTMLElement,
  fallbackOffsetsMs: Array<number | null> = [],
): { rawMd: string; blocks: NewNoteBlockInput[]; offsetsMs: Array<number | null> } {
  const children = Array.from(editorDom.children) as HTMLElement[];
  const mdChunks: string[] = [];
  const blocks: NewNoteBlockInput[] = [];
  const offsetsMs: Array<number | null> = [];

  children.forEach((child, idx) => {
    const md = blockNodeToMarkdown(child).trim();
    const offsetMs = parseTimestampToMs(child.dataset.timestamp) ?? fallbackOffsetsMs[idx] ?? null;
    offsetsMs.push(offsetMs);
    if (!md) return;
    mdChunks.push(md);
    blocks.push({
      lineIndex: blocks.length + 1,
      blockType: inferBlockTypeFromMarkdown(md),
      contentMd: md,
      recordingOffsetMs: offsetMs,
    });
  });

  return {
    rawMd: mdChunks.join("\n\n"),
    blocks,
    offsetsMs,
  };
}

export function serializeRawMarkdownToNotePayload(
  rawMd: string,
  fallbackOffsetsMs: Array<number | null> = [],
): { rawMd: string; blocks: NewNoteBlockInput[] } {
  const chunks = rawMd
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const blocks: NewNoteBlockInput[] = chunks.map((contentMd, idx) => ({
    lineIndex: idx + 1,
    blockType: inferBlockTypeFromMarkdown(contentMd),
    contentMd,
    recordingOffsetMs: fallbackOffsetsMs[idx] ?? null,
  }));

  return { rawMd, blocks };
}

/**
 * Small Markdown parser covering the note-block grammar: headings, paragraphs,
 * bullets, ordered lists, blockquotes, fenced code blocks, bold/italic/code and rules.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let inCodeFence = false;
  let codeLines: string[] = [];

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
    if (rawLine.trimStart().startsWith("```")) {
      if (inCodeFence) {
        output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCodeFence = false;
      } else {
        flushAll();
        inCodeFence = true;
      }
      continue;
    }
    if (inCodeFence) {
      codeLines.push(rawLine);
      continue;
    }

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

  if (inCodeFence && codeLines.length > 0) {
    output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushAll();
  return output.length > 0 ? output.join("") : "<p></p>";
}
