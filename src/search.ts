import { BM25Index, tokenize } from "./bm25";
import type { Chunk, Receipt, RetrievalMode } from "./types";

export interface RankedHit {
  chunk: Chunk;
  score: number;      // cosine for semantic, bm25 for bm25, rrf for hybrid
  rank: number;
  mode: RetrievalMode;
  /** raw signals kept for transparency */
  semantic?: number;
  bm25?: number;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Reciprocal rank fusion, k=60 (Cormack et al. 2009). */
export function rrf(rankings: number[][]): Map<number, number> {
  const K = 60;
  const s = new Map<number, number>();
  for (const r of rankings) {
    r.forEach((docIdx, rankPos) => {
      s.set(docIdx, (s.get(docIdx) ?? 0) + 1 / (K + rankPos + 1));
    });
  }
  return s;
}

export interface RankedResult {
  hits: RankedHit[];
  abstained: boolean;
  reason?: string;
}

/** Semantic similarity floor: below this we say "no strong match" rather
 *  than imply absence of evidence. Deliberately low — on the frozen corpus
 *  (bench/results.json) a correct answer scored 0.27 and no-answer questions
 *  scored up to 0.66, so no threshold can certify absence. This value only
 *  suppresses near-random noise; scores are always displayed so the reviewer
 *  can judge weak matches themselves. */
export const SEMANTIC_THRESHOLD = 0.25;

/** BM25 gives no comparable absolute scale; a zero/negative score means the
 *  query shares no weighted term with any chunk → honest "no match". */
export const BM25_MIN_SCORE = 0.0;

export function rankBM25(index: BM25Index, chunks: Chunk[], query: string, top = 5): RankedResult {
  const ranked = index.rank(query);
  const hits: RankedHit[] = [];
  for (let i = 0; i < Math.min(top, ranked.length); i++) {
    const r = ranked[i];
    hits.push({ chunk: chunks[r.index], score: r.score, rank: i + 1, mode: "bm25", bm25: r.score });
  }
  const best = ranked[0]?.score ?? 0;
  return {
    hits: best > BM25_MIN_SCORE ? hits : [],
    abstained: best <= BM25_MIN_SCORE,
    reason: best <= BM25_MIN_SCORE ? "No strong keyword match — inspect sources." : undefined,
  };
}

export function rankSemantic(
  chunks: Chunk[],
  chunkEmbeddings: Float32Array[],
  queryEmbedding: Float32Array,
  top = 5,
): RankedResult {
  const scored = chunks.map((_, i) => ({ i, s: cosine(queryEmbedding, chunkEmbeddings[i]) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const hits = scored.slice(0, top).map((r, i) => ({
    chunk: chunks[r.i],
    score: r.s,
    rank: i + 1,
    mode: "semantic" as RetrievalMode,
    semantic: r.s,
  }));
  const best = scored[0]?.s ?? 0;
  return {
    hits: best >= SEMANTIC_THRESHOLD ? hits : [],
    abstained: best < SEMANTIC_THRESHOLD,
    reason: best < SEMANTIC_THRESHOLD ? "No strong match — inspect sources." : undefined,
  };
}

export function rankHybrid(
  index: BM25Index,
  chunks: Chunk[],
  chunkEmbeddings: Float32Array[],
  query: string,
  queryEmbedding: Float32Array,
  top = 5,
): RankedResult {
  const bm = index.rank(query).map((r) => r.index);
  const sem = chunks
    .map((_, i) => ({ i, s: cosine(queryEmbedding, chunkEmbeddings[i]) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.i);
  const fused = rrf([sem, bm]);
  const semScore = new Map(chunks.map((_, i) => [i, cosine(queryEmbedding, chunkEmbeddings[i])]));
  const order = [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const hits = order.slice(0, top).map(([i, s], rank) => ({
    chunk: chunks[i],
    score: s,
    rank: rank + 1,
    mode: "hybrid" as RetrievalMode,
    semantic: semScore.get(i),
    bm25: index.score(tokenize(query), i),
  }));
  const bestSem = Math.max(...semScore.values());
  return {
    hits: bestSem >= SEMANTIC_THRESHOLD ? hits : [],
    abstained: bestSem < SEMANTIC_THRESHOLD,
    reason: bestSem < SEMANTIC_THRESHOLD ? "No strong match — inspect sources." : undefined,
  };
}

export function toReceipts(hits: RankedHit[]): Receipt[] {
  return hits.map((h) => ({
    chunkId: h.chunk.id,
    chunkSha256: h.chunk.sha256,
    sourceSha256: h.chunk.sourceSha256,
    score: h.score,
    mode: h.mode,
    rank: h.rank,
  }));
}
