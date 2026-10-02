export type SourceType = "readme" | "setup" | "demo" | "tests" | "limits" | "notes";

export interface SourceDoc {
  id: string;
  fileName: string;
  type: SourceType;
  /** user-supplied provenance note, e.g. "sent by author 2026-09-30" */
  provenance: string;
  text: string;
  /** sha-256 of the exact text */
  sha256: string;
  addedAt: number;
}

export interface Chunk {
  id: string;
  sourceId: string;
  /** sha-256 of the source doc that produced this chunk */
  sourceSha256: string;
  fileName: string;
  sourceType: SourceType;
  text: string;
  /** char offsets into the source — text === source.slice(charStart, charEnd) */
  charStart: number;
  charEnd: number;
  /** 1-based inclusive line range in the source file */
  lineStart: number;
  lineEnd: number;
  /** sha-256 of chunk text */
  sha256: string;
  index: number;
  approxTokens: number;
}

export type RetrievalMode = "semantic" | "bm25" | "hybrid";

export interface Receipt {
  chunkId: string;
  /** sha-256 of the chunk text AT LINK TIME — evidence snapshot, never relinked */
  chunkSha256: string;
  /** sha-256 of the source doc AT LINK TIME */
  sourceSha256: string;
  score: number;
  mode: RetrievalMode;
  /** rank within the result list (1-based) */
  rank: number;
}

export type ReviewStatus = "not_checked" | "confirmed" | "refuted" | "follow_up";

export interface Claim {
  id: string;
  text: string;
  /** "author" = rule-extracted from a source doc; "manual" = typed by reviewer */
  origin: "author" | "manual";
  sourceId?: string;
  /** 1-based line in the source the claim was extracted from (author claims) */
  sourceLine?: number;
  status: ReviewStatus;
  note: string;
  receipts: Receipt[];
  /** generation of the corpus the receipts were computed against */
  receiptEpoch: number;
  /** generation of the corpus the last search ran against; undefined = never searched */
  searchedEpoch?: number;
  /** claim text at the time the verdict was set — edits invalidate approval */
  statusText?: string;
  /** fingerprint of the evidence the verdict was recorded against — changed
   *  receipts (rerank, source edit/replace/remove/reset) invalidate approval */
  statusEvidence?: string;
  updatedAt: number;
}

export interface ReviewQuestion {
  id: string;
  text: string;
  askedAt: number;
  epoch: number;
  results: Receipt[];
  abstained: boolean;
  note: string;
}

export interface ModelState {
  status: "off" | "downloading" | "loading" | "ready" | "error";
  bytesLoaded: number;
  bytesTotal: number;
  error?: string;
  loadMs?: number;
  cancelled?: boolean;
}
