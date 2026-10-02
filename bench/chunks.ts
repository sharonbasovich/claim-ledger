// Prints chunk ids + first line for each sample doc — used to write queries.jsonl.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkSource } from "../src/chunker";
import type { SourceDoc, SourceType } from "../src/types";

const root = new URL("../public/sample/", import.meta.url).pathname;
const typeByName = (f: string): SourceType =>
  (f.split("/").pop()!.replace(/\.md$/i, "").toLowerCase() as SourceType);

const docs: SourceDoc[] = [];
for (const dir of readdirSync(root)) {
  for (const f of readdirSync(join(root, dir))) {
    const rel = `${dir}/${f}`;
    const text = readFileSync(join(root, rel), "utf8");
    docs.push({
      id: rel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      fileName: rel, type: typeByName(rel), provenance: "fictional",
      text, sha256: "", addedAt: 0,
    });
  }
}

const counts: Record<string, number> = {};
function chunksIdx(id: string) { return (counts[id] = (counts[id] ?? -1) + 1); }

const crypto = await import("node:crypto");
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
for (const d of docs) {
  d.sha256 = hash(d.text);
  for (const c of chunkSource(d)) {
    console.log(`${d.id}#c${chunksIdx(d.id)} | L${c.lineStart}-${c.lineEnd} | ${c.text.split("\n")[0].slice(0, 90)}`);
  }
}

