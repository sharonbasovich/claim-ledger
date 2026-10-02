# Threshold tuning history — full disclosure

All benchmark numbers in this repo are **exploratory, not held-out**. The frozen
corpus and 48-question set fix the *test data*, but the abstention threshold was
chosen after inspecting results on that same set, so tuned metrics must not be
read as held-out accuracy.

## Timeline

1. **Frozen in the working tree before tuning was inspected** — but NOT
   committed: the first local commit (2026-10-02T02:59:43Z) postdates all tuning
   runs. What is demonstrable is the freeze/hash chronology: `bench/queries.jsonl`
   (48 queries) sha256 `16b5c5166359bda1cb4b8cf20e129628dc391cba8d5c676d0dac09fbfb333609`
   and corpus hashes in `bench/CORPUS.sha256` existed before the τ decision.
   (Correction: this file previously claimed the corpus was "committed before
   any retrieval tuning" — false; see bench/CORRECTIONS.md.)
2. **First run, τ = 0.42** (pre-ship exploratory): produced results, then the
   output file was overwritten by a later run. **The original file is lost** —
   what survives is the observed console summary recorded in the session log:
   bm25 hit@1 0.60 / hit@3 0.80 / MRR 0.714; semantic 0.575 / 0.675 / 0.652;
   hybrid 0.525 / 0.65 / 0.618; abstention 1/8 correct, 7 false abstains.
   These numbers were produced while the paragraph-chunker was still being
   fixed, so they are **not bit-comparable** to the current chunk set.
3. **τ changed to 0.25** after inspecting the score distributions: best-match
   cosine for no-answer queries (0.37–0.66) overlaps answerable scores
   (0.27–0.67), so any higher floor only manufactures false abstains. τ=0.25 is
   a noise floor plus always-visible scores — not a certified-absence test.
4. **Re-run at τ=0.42** on a later chunk set, preserved as
   `bench/archival/results-exploratory-tau042.json` — a re-run, NOT the lost
   original. (Correction: this file previously said that re-run used "the same
   chunks" as the τ=0.25 report — false: the τ=0.42 re-run has 40 chunks, the
   older τ=0.25 report has 38, both now kept under `bench/archival/`.)

## Current artifacts

- `bench/results.json` — reproducible final-code run, τ=0.25 (40 chunks); its
  `fingerprints` section records code/corpus/queries/chunk-set/model/threshold
  hashes and the git HEAD at run time.
- `bench/archival/results-tau025-38chunk-pre-final.json` — older report on a
  pre-final chunker (38 chunks); kept unchanged as labelled archival evidence.
- `bench/archival/results-exploratory-tau042.json` — later τ=0.42 re-run
  (40 chunks); kept unchanged as labelled archival evidence.
- `bench/results.json:abstention_sweep` — correct/false abstains at
  τ ∈ {0.20, 0.30, 0.40, 0.50, 0.60}: the evidence that no threshold separates
  no-answer from answerable queries.
- `bench/CORRECTIONS.md` — manifest of every corrected false statement.

Reproduce any threshold: `BENCH_TAU=0.42 npm run bench` (add
`BENCH_OUT=<path>` to write elsewhere).
