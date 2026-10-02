/** Okapi BM25, textbook constants k1=1.5 b=0.75 (Robertson & Zaragoza 2009).
 *  Used as the keyword baseline and the no-AI fallback. */

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_'./:-]+/g) ?? [];
}

export interface BM25Doc {
  id: string;
  tokens: string[];
}

export class BM25Index {
  private df = new Map<string, number>();
  private docs: BM25Doc[] = [];
  private tf: Map<string, number>[] = [];
  private avgLen = 0;

  constructor(docs: BM25Doc[]) {
    this.docs = docs;
    let total = 0;
    for (const d of docs) {
      const tf = new Map<string, number>();
      for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tf.push(tf);
      total += d.tokens.length;
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = docs.length ? total / docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  score(queryTokens: string[], docIndex: number): number {
    const d = this.docs[docIndex];
    const tf = this.tf[docIndex];
    const len = d.tokens.length || 1;
    let s = 0;
    for (const t of queryTokens) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      s += this.idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / this.avgLen));
    }
    return s;
  }

  /** All docs scored, sorted desc; deterministic tie-break by doc index. */
  rank(query: string): { index: number; score: number }[] {
    const qt = tokenize(query);
    const out = this.docs.map((_, i) => ({ index: i, score: this.score(qt, i) }));
    out.sort((a, b) => b.score - a.score || a.index - b.index);
    return out;
  }
}
