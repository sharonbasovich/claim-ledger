import { describe, expect, it } from "vitest";
import { approxTokens, chunkSource, MAX_CHUNK_TOKENS } from "../../src/chunker";
import type { SourceDoc } from "../../src/types";

const doc = (text: string): SourceDoc => ({
  id: "test", fileName: "test.md", type: "readme", provenance: "",
  text, sha256: "", addedAt: 0,
});

describe("chunkSource", () => {
  it("splits paragraphs into separate chunks", () => {
    const c = chunkSource(doc("First paragraph here.\n\nSecond paragraph here."));
    expect(c).toHaveLength(2);
    expect(c[0].text).toContain("First paragraph");
    expect(c[1].text).toContain("Second paragraph");
  });

  it("folds a lone heading into the following paragraph", () => {
    const c = chunkSource(doc("# Title\n\nBody text that is a paragraph."));
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain("# Title");
    expect(c[0].text).toContain("Body text");
  });

  it("keeps correct line ranges", () => {
    const c = chunkSource(doc("line one\nline two\n\nline four\nline five"));
    expect(c[0].lineStart).toBe(1);
    expect(c[0].lineEnd).toBe(2);
    expect(c[1].lineStart).toBe(4);
    expect(c[1].lineEnd).toBe(5);
  });

  it("splits paragraphs that exceed the token cap", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} with several words.`).join(" ");
    const c = chunkSource(doc(long));
    expect(c.length).toBeGreaterThan(1);
    for (const p of c) expect(approxTokens(p.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS + 1);
  });

  it("handles empty, whitespace, and non-latin input", () => {
    expect(chunkSource(doc(""))).toHaveLength(0);
    expect(chunkSource(doc("   \n\n  "))).toHaveLength(0);
    const c = chunkSource(doc("のテキストです。\n\nです。"));
    expect(c).toHaveLength(2);
  });

  it("is deterministic", () => {
    const text = "# A\n\npara one\n\npara two";
    expect(chunkSource(doc(text))).toEqual(chunkSource(doc(text)));
  });
});
