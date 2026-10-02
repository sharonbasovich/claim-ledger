import type { Chunk, Claim, Receipt, ReviewQuestion, SourceDoc } from "./types";

export const MODEL_ID = "mixedbread-ai/mxbai-embed-xsmall-v1";
export const MODEL_REVISION = "e6ac24e5d6efb8782b59de1647b3ececb4ece94e";
export const MODEL_LICENSE = "Apache-2.0";


/** Backtick fence longer than any backtick run in `t`, so source text can never
 *  break out of its code block — hostile markdown/HTML stays inert in viewers. */
export function codeFence(t: string): string {
  const runs = t.match(/`+/g) ?? [];
  return "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}
/** Inline code span with the same guarantee. */
export function codeSpan(t: string): string {
  const runs = t.match(/`+/g) ?? [];
  const f = "`".repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
  return `${f} ${t} ${f}`;
}
/** Strip HTML-tag-ish and control characters for single-line metadata so raw
 *  markup can't inject elements when a viewer renders the .md. */
export function mdLine(t: string): string {
  return t.replace(/[<>]/g, "").replace(/[\r\n]+/g, " ").trim();
}

const STATUS_LABEL: Record<Claim["status"], string> = {
  not_checked: "Not checked",
  confirmed: "Reviewer-confirmed",
  refuted: "Reviewer-refuted",
  follow_up: "Follow-up needed",
};

/** A receipt is resolvable only when the current chunk matches BOTH fingerprints
 *  recorded at link time. A replaced source can reuse `doc#cN` ids, so id match
 *  alone is not evidence — and a missing fingerprint is not evidence either:
 *  legacy/partial receipts fail closed as unverifiable, never silently relinked. */
export function resolveReceipt(r: Receipt, chunks: Map<string, Chunk>):
    { chunk: Chunk; stale: false } | { chunk: undefined; stale: true; reason: string } {
  const ch = chunks.get(r.chunkId);
  if (!ch) return { chunk: undefined, stale: true, reason: "source removed" };
  if (!r.chunkSha256 || !r.sourceSha256) {
    return { chunk: undefined, stale: true, reason: "unverifiable — missing link fingerprints" };
  }
  if (ch.sha256 !== r.chunkSha256 || ch.sourceSha256 !== r.sourceSha256) {
    return { chunk: undefined, stale: true, reason: "source changed since link" };
  }
  return { chunk: ch, stale: false };
}

/** Fingerprint of the exact resolved evidence set attached to a claim — the
 *  thing a verdict actually approves. Any rerank to different chunks, or any
 *  receipt that no longer resolves, changes this key. */
export function evidenceKey(c: Claim, chunks: Map<string, Chunk>): string {
  return c.receipts.map((r) => {
    const res = resolveReceipt(r, chunks);
    return res.stale ? `${r.chunkId}:STALE:${r.chunkSha256 ?? "nofp"}`
                     : `${r.chunkId}:${res.chunk.sha256}`;
  }).sort().join("|");
}

export type Verdict =
  | { status: Exclude<Claim["status"], "not_checked">; valid: true }
  | { status: Exclude<Claim["status"], "not_checked">; valid: false; reason: string }
  | null;

/** The recorded verdict plus whether it still applies to current evidence.
 *  A verdict bound to old/missing/unverifiable evidence is invalidated, not
 *  silently renewed — the claim reverts to not-checked until fresh review. */
export function verdictOf(c: Claim, chunks: Map<string, Chunk>): Verdict {
  if (c.status === "not_checked") return null;
  if (c.statusText === undefined || c.statusText !== c.text) {
    return { status: c.status, valid: false, reason: "claim text changed since review" };
  }
  if (c.statusEvidence === undefined) {
    return { status: c.status, valid: false, reason: "recorded before evidence fingerprinting — unverifiable" };
  }
  if (evidenceKey(c, chunks) !== c.statusEvidence) {
    return { status: c.status, valid: false, reason: "evidence changed since review" };
  }
  return { status: c.status, valid: true };
}

export function effectiveStatus(c: Claim, chunks: Map<string, Chunk>): Claim["status"] {
  const v = verdictOf(c, chunks);
  return v && v.valid ? v.status : "not_checked";
}

/** Untrusted multi-line text as an inert fenced block inside a `  - ` list item:
 *  every line is indented so nothing escapes the item (a column-0 line would end
 *  the list AND the fence, letting headings/links/images render). */
function fencedBlock(t: string, indent = "    "): string[] {
  const f = codeFence(t);
  return [`${indent}${f}`, ...t.split("\n").map((l) => `${indent}${l}`), `${indent}${f}`];
}

function receiptLines(c: Claim, chunks: Map<string, Chunk>): string[] {
  const out: string[] = [];
  for (const r of c.receipts) {
    const res = resolveReceipt(r, chunks);
    if (res.stale) {
      out.push(`  - receipt (${r.mode} rank ${r.rank}, score ${r.score.toFixed(3)}): ` +
        `STALE — ${res.reason} (linked sha256:${(r.chunkSha256 ?? "?").slice(0, 12)}) — re-search needed`);
      continue;
    }
    const ch = res.chunk;
    out.push(
      `  - receipt (${r.mode} rank ${r.rank}, score ${r.score.toFixed(3)}): ` +
      `${codeSpan(ch.fileName)}:${ch.lineStart}-${ch.lineEnd} sha256:${ch.sha256.slice(0, 12)}`,
      ...fencedBlock(ch.text),
    );
  }
  return out;
}

export function exportMarkdown(
  sources: SourceDoc[],
  claims: Claim[],
  questions: ReviewQuestion[],
  chunks: Map<string, Chunk>,
  projectName: string,
  generatedAt = new Date(),
): string {
  const lines: string[] = [];
  lines.push(`# Review handoff — ${codeSpan(mdLine(projectName))}`);
  lines.push("");
  lines.push(`Generated ${generatedAt.toISOString()} by Claim Ledger (local, no server).`);
  lines.push("");
  lines.push("## Packet contents");
  lines.push("");
  for (const s of sources) {
    lines.push(`- ${codeSpan(s.fileName)} [${s.type}] sha256:${s.sha256.slice(0, 12)}` +
      (s.provenance ? ` — ${codeSpan(mdLine(s.provenance))}` : ""));
  }
  lines.push("");
  lines.push("## Claims");
  lines.push("");
  const counts = { confirmed: 0, refuted: 0, follow_up: 0, not_checked: 0 };
  for (const c of claims) {
    const v = verdictOf(c, chunks);
    counts[effectiveStatus(c, chunks)]++;
    const origin = c.origin === "author" ? "author claim" : "reviewer-entered claim";
    lines.push(`### ${STATUS_LABEL[effectiveStatus(c, chunks)]} — ${origin}` +
      (v && !v.valid ? ` — prior verdict "${STATUS_LABEL[v.status]}" invalidated (${v.reason}); needs fresh review` : ""));
    lines.push("");
    lines.push(`${codeFence(c.text)}\n${c.text}\n${codeFence(c.text)}`);
    lines.push("");
    if (c.note) lines.push(
      `- reviewer note${v && !v.valid ? " (recorded against earlier evidence)" : ""}:`,
      codeFence(c.note), c.note, codeFence(c.note));
    const rl = receiptLines(c, chunks);
    if (rl.length) lines.push("- receipts:", ...rl);
    else lines.push("- receipts: none linked yet");
    lines.push("");
  }
  lines.push(`Summary: ${counts.confirmed} confirmed · ${counts.refuted} refuted · ` +
    `${counts.follow_up} follow-up · ${counts.not_checked} not checked`);
  lines.push("");
  if (questions.length) {
    lines.push("## Reviewer questions");
    lines.push("");
    for (const q of questions) {
      lines.push(`- ${codeSpan(q.text)}${q.abstained ? " — no strong match" : ""}`);
      for (const r of q.results.slice(0, 3)) {
        const res = resolveReceipt(r, chunks);
        if (res.stale) lines.push(`  - STALE — ${res.reason} (${r.mode}, ${r.score.toFixed(3)})`);
        else lines.push(`  - ${codeSpan(res.chunk.fileName)}:${res.chunk.lineStart}-${res.chunk.lineEnd} (${res.chunk.sha256.slice(0, 12)}, ${r.mode}, ${r.score.toFixed(3)})`);
      }
      if (q.note) lines.push(`  - note: ${codeSpan(mdLine(q.note))}`);
    }
    lines.push("");
  }
  lines.push("## Method");
  lines.push("");
  lines.push(`- Embedding model: ${MODEL_ID} @ ${MODEL_REVISION.slice(0, 7)} (${MODEL_LICENSE}), q8 ONNX, runs locally in a Web Worker.`);
  lines.push("- Keyword baseline: BM25 (k1=1.5, b=0.75); hybrid = reciprocal-rank fusion.");
  lines.push("- Receipts are exact excerpts with file and line range. Similarity ranks candidates; **retrieval is not verification** — every status above was set by a human reviewer.");
  return lines.join("\n");
}

export function exportJSON(
  sources: SourceDoc[],
  claims: Claim[],
  questions: ReviewQuestion[],
  chunks: Map<string, Chunk>,
  projectName: string,
  generatedAt = new Date(),
): string {
  const chunkInfo = (r: Receipt) => {
    const res = resolveReceipt(r, chunks);
    if (res.stale) {
      return {
        chunkId: r.chunkId, stale: true, reason: res.reason,
        linkedChunkSha256: r.chunkSha256, linkedSourceSha256: r.sourceSha256,
      };
    }
    const c = res.chunk;
    return {
      chunkId: c.id, file: c.fileName, lines: [c.lineStart, c.lineEnd],
      sha256: c.sha256, sourceSha256: c.sourceSha256, sourceType: c.sourceType,
      text: c.text, stale: false,
    };
  };
  return JSON.stringify({
    tool: "claim-ledger",
    version: 1,
    project: projectName,
    generatedAt: generatedAt.toISOString(),
    model: { id: MODEL_ID, revision: MODEL_REVISION, license: MODEL_LICENSE, format: "onnx-q8" },
    disclaimer: "Retrieval ranks candidate receipts; it is not verification. All statuses were set by a human reviewer. Source labels are user-provided, not AI-certified.",
    sources: sources.map((s) => ({
      fileName: s.fileName, type: s.type, provenance: s.provenance,
      sha256: s.sha256, addedAt: new Date(s.addedAt).toISOString(),
    })),
    claims: claims.map((c) => {
      const v = verdictOf(c, chunks);
      return {
        text: c.text, origin: c.origin, sourceId: c.sourceId,
        status: effectiveStatus(c, chunks), note: c.note,
        ...(v && !v.valid ? { invalidated_verdict: { status: v.status, reason: v.reason } } : {}),
        receipts: c.receipts.map((r) => ({ ...r, chunk: chunkInfo(r) })),
      };
    }),
    questions: questions.map((q) => ({
      text: q.text, askedAt: new Date(q.askedAt).toISOString(),
      abstained: q.abstained, note: q.note,
      results: q.results.map((r) => ({ ...r, chunk: chunkInfo(r) })),
    })),
  }, null, 2);
}
