import { describe, expect, it } from "vitest";
import { cosine, rankBM25, rankSemantic, rrf, SEMANTIC_THRESHOLD } from "../../src/search";
import { BM25Index, tokenize } from "../../src/bm25";
import type { Chunk } from "../../src/types";

const mkChunk = (id: string, text: string): Chunk => ({
  id, sourceId: id, sourceSha256: "srcsha", fileName: `${id}.md`, sourceType: "readme",
  text, charStart: 0, charEnd: text.length, lineStart: 1, lineEnd: 2, sha256: "x", index: 0, approxTokens: 10,
});

describe("cosine", () => {
  it("1 for identical, 0 for orthogonal", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });
});

describe("rrf", () => {
  it("fuses two rankings favoring docs ranked high in both", () => {
    const s = rrf([[0, 1, 2], [1, 0, 2]]);
    expect(s.get(0)!).toBeGreaterThan(s.get(2)!);
    expect(s.get(1)!).toBeGreaterThan(s.get(2)!);
  });
});

describe("rankBM25", () => {
  const chunks = [mkChunk("a", "port 3000 relay"), mkChunk("b", "offline hiking trails")];
  const idx = new BM25Index(chunks.map((c) => ({ id: c.id, tokens: tokenize(c.text) })));
  it("abstains when nothing matches", () => {
    const r = rankBM25(idx, chunks, "quantum chromodynamics");
    expect(r.abstained).toBe(true);
    expect(r.hits).toHaveLength(0);
  });
  it("returns hits with bm25 mode labels", () => {
    const r = rankBM25(idx, chunks, "which port does the relay use");
    expect(r.hits[0].chunk.id).toBe("a");
    expect(r.hits[0].mode).toBe("bm25");
  });
});

describe("rankSemantic", () => {
  const chunks = [mkChunk("a", "x"), mkChunk("b", "y")];
  it("abstains below the threshold", () => {
    const emb = [new Float32Array([1, 0]), new Float32Array([0.9, 0.1])];
    const q = new Float32Array([-1, 0]); // negative similarity to everything
    const r = rankSemantic(chunks, emb, q);
    expect(r.abstained).toBe(true);
    expect(r.reason).toMatch(/inspect sources/i);
  });
  it("orders by cosine and reports scores", () => {
    const emb = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const q = new Float32Array([1, 0.1]);
    const r = rankSemantic(chunks, emb, q);
    expect(r.abstained).toBe(false);
    expect(r.hits[0].chunk.id).toBe("a");
  });
  it("uses the shared threshold constant", () => {
    expect(SEMANTIC_THRESHOLD).toBeGreaterThan(0);
    expect(SEMANTIC_THRESHOLD).toBeLessThan(0.5);
  });
});
