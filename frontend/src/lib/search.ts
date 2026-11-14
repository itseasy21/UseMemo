import { MEETINGS, getSpeaker, noteIndex, type Meeting } from "@/lib/demo-data";

export type SearchCategory = "memo" | "transcript" | "note" | "slide";

export type SearchDoc = {
  id: string;
  category: SearchCategory;
  meetingId: string;
  meetingTitle: string;
  title: string;
  snippet: string;
  startMs: number;
  noteNumber?: number;
  speaker?: string;
};

function makeDoc(
  meeting: Meeting,
  category: SearchCategory,
  suffix: string,
  title: string,
  rawText: string,
  startMs: number,
  extra?: Pick<SearchDoc, "noteNumber" | "speaker">,
): SearchDoc {
  return {
    id: `${meeting.id}-${category}-${suffix}`,
    category,
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    title,
    snippet: rawText,
    startMs,
    ...extra,
  };
}

export const SEARCH_DOCS: SearchDoc[] = MEETINGS.flatMap((meeting) => {
  const memo = makeDoc(
    meeting,
    "memo",
    "memo",
    meeting.title,
    `${meeting.folder} · ${meeting.tags.join(", ")} · ${meeting.summary.headline}`,
    0,
  );
  const transcripts = meeting.transcripts.map((segment) => {
    const speaker = getSpeaker(meeting, segment.speakerId);
    return makeDoc(
      meeting,
      "transcript",
      segment.id,
      `${speaker.name} · ${meeting.title}`,
      `${segment.confirmedText}${segment.unconfirmedText ? ` ${segment.unconfirmedText}` : ""}`,
      segment.startMs,
      { speaker: speaker.name },
    );
  });
  const notes = meeting.notes.map((note) => {
    const index = noteIndex(meeting, note.id) + 1;
    return makeDoc(
      meeting,
      "note",
      note.id,
      `N #${index} · ${meeting.title}`,
      note.text,
      note.startMs,
      { noteNumber: index },
    );
  });
  const slides = meeting.screenshots.map((screenshot) =>
    makeDoc(
      meeting,
      "slide",
      screenshot.id,
      `${screenshot.title} · ${meeting.title}`,
      `${screenshot.caption}. ${screenshot.slideText}`,
      screenshot.startMs,
    ),
  );
  return [memo, ...transcripts, ...notes, ...slides];
});

const CATEGORY_ORDER: Record<SearchCategory, number> = {
  memo: 0,
  transcript: 1,
  note: 2,
  slide: 3,
};

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function searchVault(query: string, limit = 30): SearchDoc[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const scored = SEARCH_DOCS.map((doc) => {
    const title = doc.title.toLowerCase();
    const snippet = doc.snippet.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (!title.includes(token) && !snippet.includes(token)) return null;
      if (title.includes(token)) score += 7;
      const occurrences = snippet.split(token).length - 1;
      score += Math.min(occurrences, 5);
    }
    score += 4 - CATEGORY_ORDER[doc.category] * 0.4;
    return { doc, score };
  })
    .filter((entry): entry is { doc: SearchDoc; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.doc.startMs - b.doc.startMs);

  return scored.slice(0, limit).map((entry) => entry.doc);
}

export function makeSnippet(text: string, query: string, max = 148): string {
  const tokens = queryTokens(query);
  const normalized = text.toLowerCase();
  let firstMatch = -1;
  for (const token of tokens) {
    const index = normalized.indexOf(token);
    if (index >= 0 && (firstMatch === -1 || index < firstMatch)) firstMatch = index;
  }
  if (firstMatch === -1) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  const padding = Math.floor(max / 3);
  const start = Math.max(0, firstMatch - padding);
  const end = Math.min(text.length, start + max);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export type HighlightPart = { text: string; match: boolean };

export function splitHighlight(text: string, query: string): HighlightPart[] {
  const tokens = [...new Set(queryTokens(query))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return [{ text, match: false }];
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  return text
    .split(regex)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      match: tokens.includes(part.toLowerCase()),
    }));
}

export const CATEGORY_META: Record<SearchCategory, { label: string; short: string }> = {
  memo: { label: "Memos", short: "Memo" },
  transcript: { label: "Transcript", short: "Transcript" },
  note: { label: "Notes", short: "Note" },
  slide: { label: "Slides", short: "Slide" },
};
