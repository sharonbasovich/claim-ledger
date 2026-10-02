// Benchmark: BM25 vs local embeddings vs RRF hybrid on the frozen fictional
// corpus. Run: `npm run bench`. Writes bench/results.json.
// The corpus and query set are hashed at freeze time — see bench/QUERIES.sha256
// and bench/CORPUS.sha256. This script warns if either drifted.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BM25Index, tokenize } from "../src/bm25";
import { chunkSource } from "../src/chunker";
import { cosine, rrf, SEMANTIC_THRESHOLD } from "../src/search";
import type { Chunk, SourceDoc, SourceType } from "../src/types";

const ROOT = new URL("..", import.meta.url).pathname;
const SAMPLE = join(ROOT, "public/sample");
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

interface Query { id: string; category: string; query: string; gold: string[] }

// ---------- load corpus ----------
const docs: SourceDoc[] = [];
for (const dir of readdirSync(SAMPLE).sort()) {
  for (const f of readdirSync(join(SAMPLE, dir)).sort()) {
    const rel = `${dir}/${f}`;
    const text = readFileSync(join(SAMPLE, rel), "utf8");
    docs.push({
      id: rel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      fileName: rel,
      type: f.replace(/\.md$/i, "").toLowerCase() as SourceType,
      provenance: "fictional", text, sha256: hash(text), addedAt: 0,
    });
  }
}
const corpusHash = createHash("sha256")
  .update(docs.map((d) => d.sha256).join(":")).digest("hex");
const chunks: Chunk[] = [];
for (const d of docs) {
  for (const [i, c] of chunkSource(d).entries()) {
    chunks.push({
      id: `${d.id}#c${i}`, sourceId: d.id, sourceSha256: d.sha256, fileName: d.fileName, sourceType: d.type,
      text: c.text, charStart: 0, charEnd: c.text.length, lineStart: c.lineStart, lineEnd: c.lineEnd,
      sha256: hash(c.text), index: i, approxTokens: 0,
    });
  }
}
console.log(`corpus: ${docs.length} docs, ${chunks.length} chunks, sha256 ${corpusHash.slice(0, 16)}`);

const queriesRaw = readFileSync(join(ROOT, "bench/queries.jsonl"), "utf8");
const queries: Query[] = queriesRaw.trim().split("\n").map((l) => JSON.parse(l));
const queriesHash = hash(queriesRaw);
const frozen = readFileSync(join(ROOT, "bench/QUERIES.sha256"), "utf8").split(" ")[0].trim();
console.log(`queries: ${queries.length} (sha256 ${queriesHash.slice(0, 16)}) ` +
  (queriesHash === frozen ? "— matches frozen hash" : "— WARNING: drifted from frozen hash"));

const bm25 = new BM25Index(chunks.map((c) => ({ id: c.id, tokens: tokenize(c.text) })));

// ---------- embeddings (Node, same q8 ONNX the browser loads) ----------
const t0 = performance.now();
const { env, pipeline } = await import("@huggingface/transformers");
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = join(ROOT, "public/models/");
const extractor = await pipeline("feature-extraction", "mxbai-embed-xsmall-v1", { dtype: "q8" });
const modelLoadMs = Math.round(performance.now() - t0);
console.log(`model loaded in ${modelLoadMs} ms (Node, local files)`);

const t1 = performance.now();
const chunkEmb: number[][] = (await extractor(chunks.map((c) => c.text),
  { pooling: "mean", normalize: true })).tolist();
const indexMs = Math.round(performance.now() - t1);
const qEmb: number[][] = (await extractor(queries.map((q) => q.query),
  { pooling: "mean", normalize: true })).tolist();

const semScore = (qi: number, ci: number) =>
  cosine(new Float32Array(qEmb[qi]), new Float32Array(chunkEmb[ci]));

// ---------- rankers ----------
function rankSem(qi: number) {
  return chunks.map((_, i) => ({ idx: i, score: semScore(qi, i) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
}
const rankBm = (q: Query) => bm25.rank(q.query).map((r) => ({ idx: r.index, score: r.score }));
function rankHyb(qi: number, q: Query) {
  const sem = rankSem(qi).map((r) => r.idx);
  const bm = rankBm(q).map((r) => r.idx);
  const fused = rrf([sem, bm]);
  return [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([i]) => ({ idx: i, score: 0 }));
}

// ---------- evaluation ----------
interface Failure { q: string; expected: string; got: string; note: string }

const cats = [...new Set(queries.map((q) => q.category))];

function evaluate(
  name: string,
  rank: (qi: number, q: Query) => { idx: number; score: number }[],
  abstains: (qi: number, best: number) => boolean,
) {
  const perCat: Record<string, { n: number; nAns: number; hit1: number; hit3: number; mrr: number; abOk: number }> =
    Object.fromEntries(cats.map((c) => [c, { n: 0, nAns: 0, hit1: 0, hit3: 0, mrr: 0, abOk: 0 }]));
  const failures: Failure[] = [];
  const rows: Record<string, unknown>[] = [];
  let hit1 = 0, hit3 = 0, mrr = 0, nAns = 0, abTP = 0, abFP = 0, abFN = 0;

  queries.forEach((q, qi) => {
    const ranked = rank(qi, q);
    const best = ranked[0]?.score ?? -Infinity;
    const abstained = abstains(qi, best);
    const cat = perCat[q.category];
    cat.n++;
    const row: Record<string, unknown> = { id: q.id, category: q.category, query: q.query, gold: q.gold };
    row[`${name}_abstained`] = abstained;
    row[`${name}_top3`] = ranked.slice(0, 3).map((r) => `${chunks[r.idx].id}@${r.score.toFixed(3)}`);
    rows.push(row);

    if (q.gold.length === 0) {
      nAns++; cat.nAns++;
      if (abstained) { abTP++; cat.abOk++; }
      else { abFN++; failures.push({ q: q.id, expected: "(abstain)", got: ranked[0] ? chunks[ranked[0].idx].id : "-", note: "false positive on a no-answer question" }); }
      return;
    }
    if (abstained) {
      abFP++;
      failures.push({ q: q.id, expected: q.gold.join(" | "), got: "(abstained)", note: "abstained on an answerable question" });
      return;
    }
    const hitIdx = ranked.findIndex((r) => q.gold.includes(chunks[r.idx].id));
    const h1 = hitIdx === 0 ? 1 : 0;
    const h3 = hitIdx >= 0 && hitIdx < 3 ? 1 : 0;
    hit1 += h1; hit3 += h3; mrr += hitIdx >= 0 ? 1 / (hitIdx + 1) : 0;
    cat.hit1 += h1; cat.hit3 += h3; cat.mrr += hitIdx >= 0 ? 1 / (hitIdx + 1) : 0;
    row[`${name}_hit1`] = h1; row[`${name}_hit3`] = h3;
    if (hitIdx !== 0) {
      failures.push({
        q: q.id, expected: q.gold.join(" | "),
        got: ranked.slice(0, 3).map((r) => chunks[r.idx].id).join(", ") || "-",
        note: hitIdx === -1 ? "gold absent from results" : `gold at rank ${hitIdx + 1}`,
      });
    }
  });

  const nAnswerable = queries.length - nAns;
  return {
    method: name,
    answerable: {
      n: nAnswerable, hit1_n: hit1, hit3_n: hit3,
      hit1: +(hit1 / nAnswerable).toFixed(3),
      hit3: +(hit3 / nAnswerable).toFixed(3),
      mrr: +(mrr / nAnswerable).toFixed(3),
    },
    abstention: {
      n_no_answer: nAns, correct: abTP, missed: abFN, false_abstains: abFP,
      precision: abTP + abFP ? +(abTP / (abTP + abFP)).toFixed(3) : null,
      recall: abTP + abFN ? +(abTP / (abTP + abFN)).toFixed(3) : null,
    },
    per_category: Object.fromEntries(Object.entries(perCat).map(([c, v]) => [c, {
      n: v.n,
      hit1: v.n - v.nAns ? +(v.hit1 / (v.n - v.nAns)).toFixed(3) : null,
      hit3: v.n - v.nAns ? +(v.hit3 / (v.n - v.nAns)).toFixed(3) : null,
      mrr: v.n - v.nAns ? +(v.mrr / (v.n - v.nAns)).toFixed(3) : null,
      abstain_ok: v.nAns ? `${v.abOk}/${v.nAns}` : null,
    }])),
    failures,
    rows,
  };
}

// TAU override: the first exploratory run used 0.42; the shipped default is 0.25.
// BENCH_TAU reproduces any run; BENCH_OUT redirects the report path.
const TAU = Number(process.env.BENCH_TAU ?? SEMANTIC_THRESHOLD);
const qTime0 = performance.now();
const results = [
  evaluate("bm25", (_qi, q) => rankBm(q), (_qi, best) => best <= 0),
  evaluate("semantic", (qi) => rankSem(qi), (_qi, best) => best < TAU),
  evaluate("hybrid", (qi, q) => rankHyb(qi, q), (qi) => Math.max(...chunks.map((_, i) => semScore(qi, i))) < TAU),
];
const perQueryMs = Math.round(((performance.now() - qTime0) / queries.length) * 10) / 10;

// Threshold sweep — evidence that no similarity cutoff separates
// no-answer from answerable queries on this corpus.
const sweep = [0.20, 0.30, 0.40, 0.50, 0.60].map((t) => {
  let correctAbstains = 0, falseAbstains = 0;
  queries.forEach((q, qi) => {
    const best = Math.max(...chunks.map((_, i) => semScore(qi, i)));
    if (q.gold.length === 0 && best < t) correctAbstains++;
    if (q.gold.length > 0 && best < t) falseAbstains++;
  });
  return { threshold: t, correct_abstains: correctAbstains, false_abstains: falseAbstains };
});

// code fingerprint: hash of every source file the bench touches, so a report
// can be tied to the exact code that produced it even before git history exists
const CODE_FILES = [
  "src/bm25.ts", "src/chunker.ts", "src/search.ts", "src/types.ts",
  "bench/run.ts", "bench/chunks.ts",
];
const codeHash = createHash("sha256");
for (const rel of CODE_FILES.sort()) {
  const p = join(ROOT, rel);
  if (existsSync(p)) codeHash.update(rel).update(readFileSync(p));
}
let gitHead: string | null = null, gitDirty = false;
try {
  const { execSync } = await import("node:child_process");
  gitHead = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  gitDirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim().length > 0;
} catch { /* no git available */ }
const chunkSetHash = createHash("sha256")
  .update(chunks.map((c) => `${c.id}:${c.sha256.slice(0, 16)}`).join(",")).digest("hex");

const report = {
  generatedAt: new Date().toISOString(),
  fingerprints: {
    code_sha256: codeHash.digest("hex"),
    code_files: CODE_FILES,
    git_head: gitHead,
    git_dirty_at_run: gitDirty,
    corpus_sha256: corpusHash,
    queries_sha256: queriesHash,
    chunk_count: chunks.length,
    chunk_set_sha256: chunkSetHash,
    model: "mixedbread-ai/mxbai-embed-xsmall-v1 @ e6ac24e5d6efb8782b59de1647b3ececb4ece94e, q8 onnx",
    abstention_threshold: TAU,
  },
  environment: {
    runtime: `node ${process.version}`, platform: `${process.platform} ${process.arch}`,
    model: "mixedbread-ai/mxbai-embed-xsmall-v1 @ e6ac24e5, q8 onnx, vendored in repo",
    chunker: `paragraphs, <=400 approx tokens`,
    notes: "Questions written by the same AI that built the app; corpus is fictional. This measures retrieval on one small synthetic packet, not real-world accuracy.",
  },
  corpus: { docs: docs.length, chunks: chunks.length, sha256: corpusHash },
  queries: { n: queries.length, sha256: queriesHash, matches_frozen: queriesHash === frozen },
  timings: { model_load_ms: modelLoadMs, index_ms: indexMs, per_query_ms: perQueryMs },
  abstention_threshold_used: TAU,
  tuning_disclosure:
    "Exploratory, not held-out. τ was tuned on this same frozen query set after inspecting an early run " +
    "(0.42 → 0.25). The original τ=0.42 raw output was overwritten and is LOST; observed console numbers " +
    "are recorded in docs/TUNING.md. A later re-run at τ=0.42 is preserved at " +
    "bench/archival/results-exploratory-tau042.json — it is a re-run, not the original. " +
    "An older τ=0.25 report generated on a pre-final chunker (38 chunks) is preserved at " +
    "bench/archival/results-tau025-38chunk-pre-final.json. " +
    "THIS file is the reproducible final-code run; its fingerprints section ties it to exact code/corpus/model. " +
    "No threshold separates no-answer from answerable queries (see abstention_sweep).",
  abstention_sweep: sweep,
  methods: results,
};
writeFileSync(join(ROOT, process.env.BENCH_OUT ?? "bench/results.json"), JSON.stringify(report, null, 2));

for (const r of results) {
  console.log(`\n== ${r.method} ==`);
  console.log(`  answerable (${r.answerable.n}): hit@1 ${r.answerable.hit1_n} (${r.answerable.hit1}) · hit@3 ${r.answerable.hit3_n} (${r.answerable.hit3}) · MRR ${r.answerable.mrr}`);
  console.log(`  no-answer (${r.abstention.n_no_answer}): abstained correctly ${r.abstention.correct}, returned results anyway ${r.abstention.missed}, false abstains ${r.abstention.false_abstains}`);
  if (r.failures.length) {
    console.log(`  failures:`);
    for (const f of r.failures) console.log(`    ${f.q}: expected [${f.expected}] got [${f.got}] — ${f.note}`);
  }
}
