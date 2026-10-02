import type { Chunk, SourceDoc } from "./types";

/** Rough token estimate: ~4 chars/token for English prose. mxbai context = 512;
 *  we keep chunks well under it so truncation never silently drops text. */
export const MAX_CHUNK_TOKENS = 400;
const CHARS_PER_TOKEN = 4;

export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split a long paragraph on sentence boundaries into token-bounded pieces.
 *  Returns [start, end) offsets — chunk text is always a verbatim slice of the
 *  source, never re-normalized. */
function splitOffsets(text: string, maxTokens: number): [number, number][] {
  if (approxTokens(text) <= maxTokens) return [[0, text.length]];
  const spans: [number, number][] = [];
  const re = /[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
  if (!spans.length) spans.push([0, text.length]);
  const pieces: [number, number][] = [];
  let [curS, curE] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (approxTokens(text.slice(curS, e)) > maxTokens) {
      pieces.push([curS, curE]);
      [curS, curE] = [s, e];
    } else {
      curE = e;
    }
  }
  pieces.push([curS, curE]);
  // a single pathological span longer than the cap: hard-split on word offsets
  const out: [number, number][] = [];
  for (const [ps, pe] of pieces) {
    if (approxTokens(text.slice(ps, pe)) <= maxTokens) { out.push([ps, pe]); continue; }
    const wre = /\S+\s*/g;
    wre.lastIndex = ps;
    let wm: RegExpExecArray | null;
    let ws = ps, we = ps;
    while ((wm = wre.exec(text)) && wm.index < pe) {
      const wb = wm.index + wm[0].length;
      if (approxTokens(text.slice(ws, wb)) > maxTokens && we > ws) {
        out.push([ws, we]);
        ws = wm.index;
      }
      we = Math.min(wb, pe);
    }
    if (ws < pe) out.push([ws, pe]);
  }
  return out;
}

interface RawPiece {
  text: string;
  /** char offsets into the source doc — text === doc.text.slice(charStart, charEnd) */
  charStart: number;
  charEnd: number;
  /** 1-based inclusive line range covering the piece */
  lineStart: number;
  lineEnd: number;
}

/** Chunk a source doc into paragraph pieces (merged if tiny), token-bounded.
 *  Byte-exact: piece text is a verbatim slice of the source between charStart
 *  and charEnd; lineStart/lineEnd cover exactly the touched lines.
 *  Deterministic: same text → same chunks. */
export function chunkSource(doc: SourceDoc): RawPiece[] {
  const text = doc.text;
  const lines = text.split("\n");
  const lineOffsets: number[] = [];
  {
    let off = 0;
    for (const l of lines) { lineOffsets.push(off); off += l.length + 1; }
  }

  // paragraph blocks = runs of non-empty lines, kept verbatim
  interface Block { lineStart: number; lineEnd: number; }
  const blocks: Block[] = [];
  let start = -1;
  lines.forEach((line, i) => {
    if (line.trim() === "") {
      if (start >= 0) { blocks.push({ lineStart: start + 1, lineEnd: i }); start = -1; }
      return;
    }
    if (start < 0) start = i;
  });
  if (start >= 0) blocks.push({ lineStart: start + 1, lineEnd: lines.length });

  const isStub = (l0: number, l1: number) =>
    l0 === l1 && /^#{1,6}\s/.test(lines[l0 - 1]);

  // fold heading-only blocks into the following paragraph (or the previous one
  // at end of file) — the merged piece spans all lines verbatim, blank line(s)
  // between heading and paragraph included
  const merged: Block[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && isStub(last.lineStart, last.lineEnd)) {
      last.lineEnd = b.lineEnd;
    } else {
      merged.push({ ...b });
    }
  }
  if (merged.length > 1 && isStub(merged[merged.length - 1].lineStart, merged[merged.length - 1].lineEnd)) {
    const stub = merged.pop()!;
    merged[merged.length - 1].lineEnd = stub.lineEnd;
  }

  const lineAt = (charOff: number) => {
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid] <= charOff) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const pieces: RawPiece[] = [];
  for (const m of merged) {
    const bStart = lineOffsets[m.lineStart - 1];
    const bEnd = lineOffsets[m.lineEnd - 1] + lines[m.lineEnd - 1].length;
    const bText = text.slice(bStart, bEnd);
    for (const [s, e] of splitOffsets(bText, MAX_CHUNK_TOKENS)) {
      const charStart = bStart + s, charEnd = bStart + e;
      pieces.push({
        text: text.slice(charStart, charEnd),
        charStart,
        charEnd,
        lineStart: lineAt(charStart),
        lineEnd: lineAt(Math.max(charStart, charEnd - 1)),
      });
    }
  }
  return pieces;
}

export async function buildChunks(doc: SourceDoc): Promise<Chunk[]> {
  const pieces = chunkSource(doc);
  const out: Chunk[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    out.push({
      id: `${doc.id}#c${i}`,
      sourceId: doc.id,
      sourceSha256: doc.sha256,
      fileName: doc.fileName,
      sourceType: doc.type,
      text: p.text,
      charStart: p.charStart,
      charEnd: p.charEnd,
      lineStart: p.lineStart,
      lineEnd: p.lineEnd,
      sha256: await sha256Hex(p.text),
      index: i,
      approxTokens: approxTokens(p.text),
    });
  }
  return out;
}

export async function buildChunksSync(doc: SourceDoc, hash: (t: string) => string): Promise<Chunk[]> {
  const pieces = chunkSource(doc);
  return pieces.map((p, i) => ({
    id: `${doc.id}#c${i}`,
    sourceId: doc.id,
    sourceSha256: doc.sha256,
    fileName: doc.fileName,
    sourceType: doc.type,
    text: p.text,
    charStart: p.charStart,
    charEnd: p.charEnd,
    lineStart: p.lineStart,
    lineEnd: p.lineEnd,
    sha256: hash(p.text),
    index: i,
    approxTokens: approxTokens(p.text),
  }));
}
