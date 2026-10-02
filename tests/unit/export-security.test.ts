import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { exportJSON, exportMarkdown, evidenceKey, verdictOf } from "../../src/export";
import type { Chunk, Claim, Receipt, SourceDoc } from "../../src/types";

const src: SourceDoc = {
  id: "qa-cobalt-limit-txt", fileName: "qa-cobalt-limit.txt", type: "readme",
  provenance: "test", text: "QA-only fictional source. The cobalt import limit is 200 items.",
  sha256: "aaa111", addedAt: 0,
};
const mkChunk = (text: string, sha: string, sourceSha: string): Chunk => ({
  id: "qa-cobalt-limit-txt#c0", sourceId: "qa-cobalt-limit-txt", sourceSha256: sourceSha,
  fileName: "qa-cobalt-limit.txt", sourceType: "readme", text,
  charStart: 0, charEnd: text.length, lineStart: 1, lineEnd: 1, sha256: sha, index: 0, approxTokens: 9,
});
const chunk200 = mkChunk("QA-only fictional source. The cobalt import limit is 200 items.", "sha200", "srcsha200");
const chunk210 = mkChunk("QA-only fictional source. The cobalt import limit is 210 items.", "sha210", "srcsha210");
const mkReceipt = (over: Partial<Receipt> = {}): Receipt => ({
  chunkId: chunk200.id, chunkSha256: "sha200", sourceSha256: "srcsha200",
  score: 0.62, mode: "semantic", rank: 1, ...over,
});
const mkClaim = (over: Partial<Claim> = {}): Claim => ({
  id: "c1", text: "The cobalt import limit is 200 items.", origin: "manual",
  status: "confirmed", note: "verified against spec",
  receipts: [mkReceipt()], receiptEpoch: 1,
  statusText: "The cobalt import limit is 200 items.",
  statusEvidence: evidenceKey(
    { id: "c1", text: "x", origin: "manual", status: "confirmed", note: "",
      receipts: [mkReceipt()], receiptEpoch: 1, updatedAt: 0 } as Claim,
    new Map([[chunk200.id, chunk200]])),
  updatedAt: 0, ...over,
});
const chunks200 = new Map([[chunk200.id, chunk200]]);
const chunks210 = new Map([[chunk210.id, chunk210]]);

describe("fail-closed receipt fingerprints (P1-1)", () => {
  it("receipt missing chunkSha256 is stale/unverifiable, never relinked", () => {
    const c = mkClaim({ receipts: [mkReceipt({ chunkSha256: undefined as unknown as string })] });
    const md = exportMarkdown([src], [c], [], chunks200, "x", new Date(0));
    expect(md).toContain("unverifiable — missing link fingerprints");
    expect(md).not.toContain("the exact receipt text");
    const j = JSON.parse(exportJSON([src], [c], [], chunks200, "x", new Date(0)));
    expect(j.claims[0].receipts[0].chunk.stale).toBe(true);
    expect(j.claims[0].receipts[0].chunk.text).toBeUndefined();
  });
  it("receipt missing sourceSha256 fails closed too", () => {
    const c = mkClaim({ receipts: [mkReceipt({ sourceSha256: undefined as unknown as string })] });
    const md = exportMarkdown([src], [c], [], chunks200, "x", new Date(0));
    expect(md).toContain("unverifiable — missing link fingerprints");
  });
  it("mismatched fingerprints stay stale; exact-current receipts resolve", () => {
    const bad = exportMarkdown([src], [mkClaim()], [], chunks210, "x", new Date(0));
    expect(bad).toContain("source changed since link");
    const good = exportMarkdown([src], [mkClaim()], [], chunks200, "x", new Date(0));
    expect(good).toContain("The cobalt import limit is 200 items");
    expect(good).not.toContain("STALE");
  });
  it("removed source marks stale in markdown and JSON", () => {
    const md = exportMarkdown([src], [mkClaim()], [], new Map(), "x", new Date(0));
    expect(md).toContain("source removed");
    const j = JSON.parse(exportJSON([src], [mkClaim()], [], new Map(), "x", new Date(0)));
    expect(j.claims[0].receipts[0].chunk.reason).toBe("source removed");
  });
});

describe("verdict bound to evidence (P1-2)", () => {
  it("verdict valid while evidence fingerprint matches", () => {
    const v = verdictOf(mkClaim(), chunks200);
    expect(v).toEqual({ status: "confirmed", valid: true });
    const md = exportMarkdown([src], [mkClaim()], [], chunks200, "x", new Date(0));
    expect(md).toContain("### Reviewer-confirmed");
    expect(md).not.toContain("invalidated");
  });
  it("source replacement invalidates the verdict — not silently renewed", () => {
    const v = verdictOf(mkClaim(), chunks210);
    expect(v).toMatchObject({ status: "confirmed", valid: false });
    const md = exportMarkdown([src], [mkClaim()], [], chunks210, "x", new Date(0));
    expect(md).toContain('prior verdict "Reviewer-confirmed" invalidated');
    expect(md).toContain("### Not checked");
    expect(md).toContain("(recorded against earlier evidence)");
    const j = JSON.parse(exportJSON([src], [mkClaim()], [], chunks210, "x", new Date(0)));
    expect(j.claims[0].status).toBe("not_checked");
    expect(j.claims[0].invalidated_verdict.status).toBe("confirmed");
  });
  it("rerank to different chunks invalidates; identical rerank keeps it", () => {
    const reranked = mkClaim({ receipts: [mkReceipt({ chunkId: "other#c0", chunkSha256: "s9", sourceSha256: "s9" })] });
    const chunksOther = new Map([["other#c0", mkChunk("other", "s9", "s9")]]);
    // verdict was recorded against chunk200 — reranked evidence differs
    expect(verdictOf(reranked, chunksOther)!.valid).toBe(false);
    // identical evidence set (same ids + fingerprints) stays valid
    const same = mkClaim({
      statusEvidence: evidenceKey(reranked, chunksOther),
      receipts: [mkReceipt({ chunkId: "other#c0", chunkSha256: "s9", sourceSha256: "s9", score: 0.9, mode: "hybrid" })],
    });
    expect(verdictOf(same, chunksOther)!.valid).toBe(true);
  });
  it("verdict recorded before fingerprinting (migration) fails closed", () => {
    const legacy = mkClaim({ statusEvidence: undefined });
    expect(verdictOf(legacy, chunks200)).toMatchObject({ valid: false });
    const md = exportMarkdown([src], [legacy], [], chunks200, "x", new Date(0));
    expect(md).toContain("unverifiable");
  });
  it("claim text edit invalidates", () => {
    const edited = mkClaim({ text: "The cobalt import limit is 300 items." });
    expect(verdictOf(edited, chunks200)).toMatchObject({ valid: false, reason: "claim text changed since review" });
  });
});

describe("markdown structural inertness (P1-3)", () => {
  const mdit = new MarkdownIt({ html: true, linkify: false });
  const hostile = [
    "# INJECTED HEADING",
    "[click me](javascript:alert(1))",
    '<img src=x onerror=alert(1)>',
    "normal line 2",
  ].join("\n");
  const hChunk = mkChunk(hostile, "hsha", "hsrcsha");
  const hMap = new Map([[hChunk.id, hChunk]]);
  const hClaim = mkClaim({
    text: "claim", status: "not_checked",
    receipts: [{ chunkId: hChunk.id, chunkSha256: "hsha", sourceSha256: "hsrcsha", score: 0.5, mode: "bm25", rank: 1 }],
  });
  const prov: SourceDoc = { ...src, sha256: "hsrcsha", fileName: 'a](javascript:0)[x', provenance: "[click](javascript:evil) <b>hi</b>" };
  const md = exportMarkdown([prov], [hClaim], [], hMap, '[proj](javascript:1)', new Date(0));
  const html = mdit.render(md);
  it("untrusted multi-line receipt text produces no injected headings/links/images", () => {
    expect(html).not.toContain("<h1>INJECTED HEADING");
    expect(html).not.toContain("<a href");
    expect(html).not.toContain("<img");
    // real document structure intact
    expect(html).toContain("<h1>");
    expect(html).toContain("Review handoff");
    // the hostile text survives verbatim as data inside code blocks
    expect(html).toContain("INJECTED HEADING");
    expect(html).toContain("javascript:alert(1)");
    expect(html).toContain("onerror=alert(1)");
  });
  it("hostile provenance/filename/project metadata emits no active links", () => {
    // markdown-it with linkify off: only explicit [..](..) syntax creates links
    expect((html.match(/<a /g) ?? []).length).toBe(0);
  });
  it("receipt code fence cannot be escaped by inline backtick runs", () => {
    const tricky = mkChunk("text with ``` fence ``` and ` inline", "tsha", "tsrc");
    const tm = new Map([[tricky.id, tricky]]);
    const tc = mkClaim({ receipts: [{ chunkId: tricky.id, chunkSha256: "tsha", sourceSha256: "tsrc", score: 0.5, mode: "bm25", rank: 1 }] });
    const m2 = exportMarkdown([src], [tc], [], tm, "x", new Date(0));
    const h2 = mdit.render(m2);
    expect((h2.match(/<h\d>/g) ?? []).filter((x) => x !== "<h1>").length + (h2.match(/<h1>/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(h2).toContain("``` fence ```");
  });
});
