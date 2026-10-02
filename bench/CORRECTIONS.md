# Corrections manifest

Independent QA of the first release bundle found false statements in the docs.
This file records each correction; the original artifact bytes are preserved
unchanged under `bench/archival/` as historical evidence.

## What is preserved unchanged

| file | what it actually is |
|---|---|
| `bench/archival/results-tau025-38chunk-pre-final.json` | τ=0.25 report generated 2026-10-02T02:37:45Z on a pre-final chunker (38 chunks). NOT the final-code result. |
| `bench/archival/results-exploratory-tau042.json` | A LATER re-run at τ=0.42 on a 40-chunk corpus. NOT the original first run. |

The original first τ=0.42 raw output file was overwritten in-session and is
**lost**. Only the observed console summary survives (see docs/TUNING.md).

## Corrections

1. **Stale headline table.** README/article previously showed Hit@1 0.600 /
   0.650 / 0.650 (24/40, 26/40, 26/40) from the 38-chunk report. The final-code
   reproducible run in `bench/results.json` gives BM25 20/40 (0.500), semantic
   23/40 (0.575), hybrid 23/40 (0.575). Tables re-derived from that file.
2. **"Same chunks" claim.** docs/TUNING.md said the τ=0.42 re-run used the same
   chunks as results.json. False: 40 vs 38 chunks. Corrected.
3. **Negation superiority.** README/article claimed semantic beats BM25 on
   negation queries. Actual per-category Hit@1 (final code): negation BM25
   0.625 vs semantic 0.375 — a semantic loss, kept. Semantic wins paraphrase
   (0.625 vs 0.250) and numbers (0.625 vs 0.250); BM25 also wins identifiers
   (0.875 vs 0.750).
4. **"First raw preserved".** The τ=0.42 file's `tuning_disclosure` pointed at
   a nonexistent `results-first-run-tau042.json`; the article called the file
   "the raw exploratory run". Both wrong — it is a re-run; the original is
   lost. Corrected everywhere.
5. **Human-involvement claims.** Removed "The owner reviewed the output"
   (README, article), "hand-written" queries (article — they were AI-drafted),
   and the fabricated recurring-workflow line "Every handoff is the same
   grind" (article). The teammate exists but has not used the tool.
6. **Build/freeze record.** README said the build started ~02:10 UTC and the
   corpus was "frozen before tuning". The builder session began
   ~2026-10-02T02:19:33Z; first local commit 02:59:43Z postdates all tuning
   runs, so nothing was committed before tuning. Only the working-tree
   freeze/hash chronology is now claimed.
7. **Integrity fixes (code, not just docs).**
   - Epoch race: `ensureEmbeddings`/`findReceipts` captured the corpus epoch
     and chunk snapshot BEFORE awaiting and drop late results on any source
     change/reset. Embeddings are tagged with the generation that produced
     them and keyed to an exact chunk-set fingerprint.
   - Stale receipts: every receipt now stores the linked chunk's sha256 and
     the source doc's sha256 at link time. UI and exports verify the
     fingerprint; a mismatched receipt is shown/exported as STALE — new text
     is never rendered or quoted under an old score.
   - Byte-exact receipts: chunks are verbatim source slices with char offsets
     and exact line ranges; exports quote the complete chunk text (no
     truncation).
   - Claim extraction: complete sentences across Markdown hard-wraps, no
     headers as claims, decimals not split, source line recorded per claim.
   - Export safety: untrusted text is fenced with a backtick fence longer
     than any run inside it; single-line metadata is escaped.
   - Service worker: cache name derives from the deployed index.html hash so
     a repaired build always replaces a stale one; only this app's caches are
     deleted on activate.

## Second independent retest (post-release) — integrity repairs

8. **Fail-open fingerprint check.** `resolveReceipt` only validated when
   `r.chunkSha256` was truthy, so legacy/partial receipts resolved replacement
   text under an old score. Resolution now requires BOTH link-time
   fingerprints; absent or mismatched fingerprints fail closed as
   `unverifiable — missing link fingerprints` / `source changed since link`,
   in UI, Markdown and JSON alike.
9. **Verdicts not bound to evidence.** A `Confirmed` verdict survived a source
   replacement and re-rank that produced different evidence. Verdicts now
   record `statusEvidence` — a fingerprint of the resolved receipt set
   (claim text + chunk fingerprints) at verdict time. Any change that alters
   the resolved evidence (rerank to different chunks, source
   edit/replace/delete/reset, model-enable auto-refresh to new evidence,
   edits to the claim) invalidates the prior verdict: UI shows
   `prior verdict "…" invalidated — <reason>; re-review to confirm`, counts
   and exports treat the claim as not-checked, exports record
   `invalidated_verdict` with the reason, and reviewer notes are kept and
   labelled `(recorded against earlier evidence)`. Identical re-linked
   evidence keeps the verdict. Persisted pre-change verdicts without a
   fingerprint fail closed as unverifiable on reload.
10. **Markdown escape via multi-line receipts.** Only the first line of a
    quoted receipt was indented, so line 2+ of untrusted chunk text left the
    list item and closed the containing fence — injected headings, links and
    raw HTML parsed as real Markdown. All untrusted multi-line text is now
    indented per line inside an unbreakable fence, and provenance/project/
    question-note metadata is emitted as inert code spans (active
    `[x](y)` Markdown links can no longer form). Regressed with markdown-it
    14.1.0 structural assertions, not substring checks.
11. **Lost last write on fast reload.** `saveState` debounced 250ms; a
    verdict→reload sequence could discard the last mutation. Writes are now
    serialized immediately with a `pagehide` flush.
