import type { Claim, SourceDoc } from "./types";

/** Rule-based claim extraction — no AI. Complete sentences from docs that carry
 *  a capability verb, a measurable number, or a support/limitation signal become
 *  candidate "author claims". The reviewer edits or dismisses them freely. */

const CAPABILITY = /\b(supports?|works?|runs?|handles?|allows?|lets? you|can |offline|syncs?|encrypts?|exports?|imports?|backs? up|auto(?:matically)?|real[- ]?time|multi-?user|unlimited|free|open[- ]source|no (?:account|signup|tracking|server)|end-to-end)\b/i;
const NUMBER = /\b\d+(?:\.\d+)?\s*(?:%|ms|s|seconds?|minutes?|hours?|mb|gb|kb|px|users?|devices?|tests?|items?|records?|files?|requests?|ops|fps|x)\b|\b\d+\s*\/\s*\d+\b|\bv\d+\.\d+/i;
const LIMIT = /\b(limit(?:ed|s|ation)?|cap(?:ped|s)?(?:\s+at|\s+of)?|maximum|up to|at most|only|must|requires?|does not|doesn't|not supported|unsupported|fails?|won't|cannot|can't|no support)\b/i;

const ABBREV = /\b(e\.g|i\.e|etc|vs|approx|cf|dr|mr|ms|st|no|fig)\.$/i;

/** Split a paragraph into complete sentences. A `.`/`!`/`?` ends a sentence only
 *  at whitespace/end boundaries — never inside decimals ("1.75"), mid-token
 *  ("v1.8", URLs) or after common abbreviations ("e.g."). */
function sentenceSplit(paragraph: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    const c = paragraph[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    const next = paragraph[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue; // decimal / mid-token
    if (c === "." && ABBREV.test(paragraph.slice(Math.max(0, i - 8), i + 1))) continue;
    out.push({ text: paragraph.slice(start, i + 1).trim(), start });
    start = i + 1;
    while (start < paragraph.length && /\s/.test(paragraph[start])) start++;
  }
  if (start < paragraph.length) out.push({ text: paragraph.slice(start).trim(), start });
  return out;
}

/** Split into complete sentences spanning Markdown hard-wraps: lines within a
 *  paragraph are joined with spaces, then split at real sentence ends. Skips
 *  code fences, URLs, markdown headers and list-formatting noise.
 *  `lineStart` is the 1-based source line the sentence begins on. */
export function sentences(text: string): { text: string; lineStart: number }[] {
  const out: { text: string; lineStart: number }[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let joined = "";
  // joined-offset → source line, so sentence provenance survives the join
  const marks: { idx: number; line: number }[] = [];

  const flush = () => {
    for (const s of sentenceSplit(joined)) {
      if (s.text.length < 12 || s.text.length > 600) continue;
      let lineStart = marks[0]?.line ?? 1;
      for (const m of marks) if (m.idx <= s.start) lineStart = m.line;
      out.push({ text: s.text, lineStart });
    }
    joined = "";
    marks.length = 0;
  };

  lines.forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (raw.startsWith("```")) { inFence = !inFence; flush(); return; }
    if (inFence) return;
    if (!raw || raw.startsWith("http") || /^[-*`#_=\s]*$/.test(raw) || /^#{1,6}\s/.test(raw)) {
      flush();
      return;
    }
    const cleaned = raw.replace(/^[-*>•+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (joined) joined += " ";
    marks.push({ idx: joined.length, line: i + 1 });
    joined += cleaned;
  });
  flush();
  return out;
}

export function isClaimLike(sentence: string): boolean {
  const caps = CAPABILITY.test(sentence);
  const nums = NUMBER.test(sentence);
  const lims = LIMIT.test(sentence);
  // a claim needs a capability/limitation signal; numbers alone are noise
  return (caps && (nums || lims)) || (caps && !/^see |^for example/i.test(sentence)) || lims;
}

export interface ExtractedClaim {
  text: string;
  sourceId: string;
  lineStart: number;
}

export function extractClaims(docs: SourceDoc[]): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  for (const d of docs) {
    if (d.type === "tests") continue; // test docs supply evidence, not claims
    for (const s of sentences(d.text)) {
      if (isClaimLike(s.text)) out.push({ text: s.text, sourceId: d.id, lineStart: s.lineStart });
    }
  }
  return out;
}

let seq = 0;
export function newClaimId(): string {
  return `cl-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

export function claimFromExtracted(e: ExtractedClaim, epoch: number): Claim {
  return {
    id: newClaimId(),
    text: e.text,
    origin: "author",
    sourceId: e.sourceId,
    sourceLine: e.lineStart,
    status: "not_checked",
    note: "",
    receipts: [],
    receiptEpoch: epoch,
    updatedAt: Date.now(),
  };
}
