import { describe, expect, it } from "vitest";
import { BM25Index, tokenize } from "../../src/bm25";

const docs = [
  { id: "a", tokens: tokenize("offline mode requires downloaded tiles") },
  { id: "b", tokens: tokenize("the relay server stores only ciphertext") },
  { id: "c", tokens: tokenize("port 8080 serves the web interface") },
];

describe("tokenize", () => {
  it("lowercases and splits on punctuation", () => {
    expect(tokenize("TrailMend_TILE dir:4173")).toEqual(["trailmend_tile", "dir:4173"]);
  });
  it("handles empty and non-latin text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("のテキスト")).toEqual([]);
  });
});

describe("BM25Index", () => {
  const idx = new BM25Index(docs);

  it("ranks the doc sharing query terms first", () => {
    const r = idx.rank("which port serves web interface");
    expect(docs[r[0].index].id).toBe("c");
  });

  it("returns zero score for terms absent from the corpus", () => {
    const r = idx.rank("zyxqwv nonexistent");
    expect(r[0].score).toBe(0);
  });

  it("is deterministic under ties (stable by doc order)", () => {
    const r1 = idx.rank("zzzqqq");
    const r2 = idx.rank("zzzqqq");
    expect(r1.map((r) => r.index)).toEqual(r2.map((r) => r.index));
    expect(r1.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("longer queries with one rare term still rank that doc first", () => {
    const r = idx.rank("tell me everything about ciphertext storage");
    expect(docs[r[0].index].id).toBe("b");
  });
});
