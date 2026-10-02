import { describe, expect, it } from "vitest";
import { extractClaims, isClaimLike, sentences } from "../../src/claims";
import type { SourceDoc } from "../../src/types";

const doc = (text: string, type: SourceDoc["type"] = "readme"): SourceDoc => ({
  id: "t", fileName: "t.md", type, provenance: "", text, sha256: "", addedAt: 0,
});

describe("isClaimLike", () => {
  it("accepts capability statements with numbers", () => {
    expect(isClaimLike("It supports exporting a PDF of 40 pages.")).toBe(true);
    expect(isClaimLike("Sync runs on a 30-second interval.")).toBe(true);
  });
  it("accepts limitation statements", () => {
    expect(isClaimLike("Offline planning is not supported.")).toBe(true);
    expect(isClaimLike("Notes are capped at 2 MB.")).toBe(true);
  });
  it("rejects bare prose", () => {
    expect(isClaimLike("The hiking app is nice and friendly for users.")).toBe(false);
    expect(isClaimLike("Welcome.")).toBe(false);
  });
});

describe("sentences", () => {
  it("skips headings-only noise and URLs", () => {
    const s = sentences("# Title\nhttps://example.com\nThis sentence is long enough to keep.");
    expect(s.some((x) => x.text.includes("example.com"))).toBe(false);
    expect(s.some((x) => x.text.includes("sentence"))).toBe(true);
  });
});

describe("extractClaims", () => {
  it("extracts claims from prose docs and skips test records", () => {
    const docs = [
      doc("It supports offline mode and syncs automatically over wifi."),
      doc("test result: ok. 9 passed; 1 failed.", "tests"),
    ];
    const c = extractClaims(docs);
    expect(c.some((x) => x.text.includes("offline mode"))).toBe(true);
    expect(c.some((x) => x.text.includes("passed"))).toBe(false);
  });
});

describe("sentences — hard-wrap and decimals", () => {
  it("joins hard-wrapped lines into complete sentences", () => {
    const s = sentences("It is free and\nsyncs between machines automatically over wifi.");
    expect(s[0].text).toBe("It is free and syncs between machines automatically over wifi.");
  });
  it("does not split on decimals or version numbers", () => {
    const s = sentences("Install with cargo install inkwell-sync (Rust 1.78+). Next sentence works offline here.");
    expect(s[0].text).toContain("1.78+");
    expect(s).toHaveLength(2);
  });
  it("skips markdown headers and keeps line provenance", () => {
    const s = sentences("## Limits\n\nIt caps notes at 2 MB.");
    expect(s).toHaveLength(1);
    expect(s[0].lineStart).toBe(3);
    expect(s[0].text).not.toContain("##");
  });
  it("keeps full bullets without stripping mid-sentence", () => {
    const s = sentences("- It supports offline sync on up to 5 devices.");
    expect(s[0].text).toBe("It supports offline sync on up to 5 devices.");
  });
});
