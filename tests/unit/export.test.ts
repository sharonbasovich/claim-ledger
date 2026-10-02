import { describe, expect, it } from "vitest";
import { evidenceKey, exportJSON, exportMarkdown, MODEL_ID } from "../../src/export";
import type { Chunk, Claim, SourceDoc } from "../../src/types";

const src: SourceDoc = {
  id: "readme-md", fileName: "README.md", type: "readme",
  provenance: "test", text: "hello", sha256: "abc123def456", addedAt: 0,
};
const chunk: Chunk = {
  id: "readme-md#c0", sourceId: "readme-md", sourceSha256: "abc123def456", fileName: "README.md",
  sourceType: "readme", text: "the exact receipt text", charStart: 0, charEnd: 21, lineStart: 1, lineEnd: 3,
  sha256: "deadbeefcafe1234", index: 0, approxTokens: 5,
};
const claim: Claim = {
  id: "c1", text: "It works offline.", origin: "author", sourceId: "readme-md",
  status: "confirmed", note: "checked by hand",
  receipts: [{ chunkId: "readme-md#c0", chunkSha256: "deadbeefcafe1234", sourceSha256: "abc123def456", score: 0.62, mode: "semantic", rank: 1 }],
  receiptEpoch: 1,
  statusText: "It works offline.",
  // bound to the exact evidence set below so the verdict stays valid
  statusEvidence: evidenceKey(
    { id: "x", text: "x", origin: "author", status: "confirmed", note: "",
      receipts: [{ chunkId: "readme-md#c0", chunkSha256: "deadbeefcafe1234", sourceSha256: "abc123def456", score: 0, mode: "semantic", rank: 1 }],
      receiptEpoch: 1, updatedAt: 0 },
    new Map([[chunk.id, chunk]])),
  updatedAt: 0,
};
const chunks = new Map([[chunk.id, chunk]]);

describe("exportMarkdown", () => {
  const md = exportMarkdown([src], [claim], [], chunks, "demo", new Date(0));
  it("includes claim status, receipt quote, location and hash", () => {
    expect(md).toContain("Reviewer-confirmed");
    expect(md).toContain("the exact receipt text");
    expect(md).toContain("README.md `:1-3");
    expect(md).toContain("deadbeefcafe");
  });
  it("carries the not-verification disclaimer and model id", () => {
    expect(md).toContain("retrieval is not verification");
    expect(md).toContain(MODEL_ID);
  });
  it("never calls an unchecked claim confirmed", () => {
    const md2 = exportMarkdown([src], [{ ...claim, status: "not_checked" }], [], chunks, "x", new Date(0));
    expect(md2).toContain("Not checked");
    expect(md2).not.toContain("Reviewer-confirmed");
  });
});

describe("exportJSON", () => {
  const j = JSON.parse(exportJSON([src], [claim], [], chunks, "demo", new Date(0)));
  it("embeds chunk text, lines, sha and mode in receipts", () => {
    const r = j.claims[0].receipts[0];
    expect(r.chunk.text).toBe("the exact receipt text");
    expect(r.chunk.lines).toEqual([1, 3]);
    expect(r.chunk.sha256).toBe("deadbeefcafe1234");
    expect(r.mode).toBe("semantic");
  });
  it("disclaims AI certification of source labels", () => {
    expect(j.disclaimer).toMatch(/not AI-certified/);
  });
});

describe("stale receipt fingerprints", () => {
  it("exports STALE marker, never new text under an old score", () => {
    const replacement: Chunk = { ...chunk, text: "completely different new text", sha256: "aaaa0000bbbb" };
    const md = exportMarkdown([src], [claim], [], new Map([[replacement.id, replacement]]), "demo", new Date(0));
    expect(md).toContain("STALE");
    expect(md).not.toContain("completely different new text");
    const json = exportJSON([src], [claim], [], new Map([[replacement.id, replacement]]), "demo", new Date(0));
    const parsed = JSON.parse(json) as { claims: { receipts: { chunk: { stale: boolean } }[] }[] };
    expect(parsed.claims[0].receipts[0].chunk.stale).toBe(true);
  });
  it("exports matching fingerprints with exact quote and hash", () => {
    const md = exportMarkdown([src], [claim], [], chunks, "demo", new Date(0));
    expect(md).toContain("the exact receipt text");
    expect(md).not.toContain("STALE");
  });
});

describe("markdown safety", () => {
  it("hostile source text stays inside code fences", () => {
    const evil: SourceDoc = { ...src, fileName: "evil`[x](javascript:alert(1))`.md", provenance: "<img src=x onerror=alert(1)>" };
    const evilClaim: Claim = { ...claim, text: "<script>alert(1)</script>\n```\nbreakout", note: "[x](javascript:alert(1))" };
    const md = exportMarkdown([evil], [evilClaim], [], chunks, "p<script>roj", new Date(0));
    // the hostile claim text is preserved verbatim but strictly inside a fence
    // longer than its own backtick run, so it can never render as markup
    const open = md.indexOf("````");
    const payload = md.indexOf("<script>");
    const close = md.indexOf("````", open + 4);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(payload).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(payload);
    // metadata is escaped, never fenced: no raw tag survives outside fences
    const unfenced = md.replace(/^(`{3,})\n[\s\S]*?\n\1$/gm, "");
    expect(md.split("\n")[0]).not.toContain("<");
    expect(unfenced).not.toContain("<img");
    // any leftover hostile scheme text must sit inside a code-spanned metadata line
    const jsLines = unfenced.split("\n").filter((l) => l.includes("javascript:"));
    expect(jsLines.length).toBeGreaterThan(0);
    expect(jsLines.every((l) => l.startsWith("- `"))).toBe(true);
  });
});
