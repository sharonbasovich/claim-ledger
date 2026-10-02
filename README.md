# Claim Ledger

A local-first **review desk** for project handoffs. A teammate drops a project packet on you — READMEs, setup notes, test records, known limitations — and you have to decide what to actually verify. Claim Ledger turns that packet into a set of checkable claims, pulls **source receipts** (exact excerpts with file, line range and content hash) for each claim, and lets a *human* record the verdict: confirmed, refuted, needs follow-up, or not checked.

The model only ranks nearby snippets. It never verifies truth, and it never writes prose answers.

> **Fully Autonomous AI construction.** This project was researched, designed, implemented, tested, benchmarked and documented by AI agents (Devin, by Cognition) under the owner's direction — including this README and the article draft. Automated tests and the frozen benchmark are machine QA, not human feedback. No human wrote the code; owner review of the output has not been confirmed.

## Why it exists

The owner has a real teammate who does independent second-pass review of project handoffs. That workflow — "here's a packet, tell me what to check" — is the problem being solved. It has not yet been tried by that teammate; there is no usage feedback to report.

## The workflow

1. **Load sources** — import `.txt`/`.md` files (or paste), or click *Load fictional example packet* for a labelled synthetic 3-project corpus.
2. **Claims** — claim-like lines are extracted automatically from documentation, or type claims manually ("`max 2 concurrent syncs`").
3. **Find receipts** — each claim is matched against source chunks by BM25 keywords, semantic embeddings, or a hybrid (reciprocal-rank fusion). Receipts carry `file:line`, the retrieval mode, the score and a sha256 fingerprint.
4. **You decide** — every claim keeps a reviewer-set status and note. The app never sets them.
5. **Ask** — free-text questions get candidate excerpts, or an honest *"No strong match — inspect sources"* when nothing clears the noise floor.
6. **Export** — a Markdown/JSON handoff packet with claim statuses, quoted receipts, fingerprints and an explicit *"retrieval is not verification"* footer.

Editing or removing a source bumps the epoch and marks all stale receipts/questions so nothing survives on a changed packet.

## Honest-by-design wording

Similarity can't prove a negative. The app says *"no linked receipt yet"* and *"no strong match — inspect sources"*, and shows raw scores — it never claims evidence is absent. Source labels are **user-provided**, not AI-certified. Reviewer observations stay separate from imported text.

## Local AI, no accounts

- **Model:** [`mixedbread-ai/mxbai-embed-xsmall-v1`](https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1), revision `e6ac24e5d6efb8782b59de1647b3ececb4ece94e`, q8 ONNX (~24.4 MB), Apache-2.0 — placed under `public/models/` by `npm run assets` (sha256-verified), served from the same static host.
- **Runtime:** [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) 4.3.0 + ONNX Runtime Web WASM (in `public/ort/`, copied from the package-lock-pinned npm package by `npm run assets`). CPU/WASM only — no WebGPU, no API key, no backend, no telemetry.
- **Inference runs in a Web Worker.** Embeddings are mean-pooled, L2-normalized, 384-dim; symmetric encoding (no query prefix), per the model card.
- **Keyword-only mode** is always available without the model — every result is labelled with its retrieval mode.
- First enable downloads ~27 MB total (model + ONNX runtime WASM) with a live byte-progress bar, cancel and retry. A build-versioned service worker caches the app shell; transformers.js caches the model in the Cache API, so reloads are fast. *Network note:* the site, runtime and model assets come from your static host — those initial requests expose ordinary network metadata (IP, user agent, timing) to the host. Imported text and questions never leave the browser.

## Benchmark — real numbers, honest failures

A **frozen** benchmark (`bench/queries.jsonl`, 48 queries — AI-drafted, not hand-written — sha256 in `bench/QUERIES.sha256`) covers paraphrase, exact identifier, negation, numbers, no-answer and cross-project-confusion categories against the 12-doc fictional corpus (40 chunks on final code). Reproduce:

```bash
npm ci && npm run bench            # writes bench/results.json
BENCH_TAU=0.42 npm run bench       # re-run at the exploratory threshold
```

Results on the frozen corpus (Node 24, x86_64, q8 model):

| method | Hit@1 | Hit@3 | MRR | no-answer correctly abstained |
|---|---|---|---|---|
| BM25 (real implementation, k1=1.5 b=0.75) | 0.500 (20/40) | 0.775 | 0.642 | 0/8 |
| semantic (mxbai-embed-xsmall-v1, cosine) | **0.575** (23/40) | 0.725 | 0.694 | 0/8 |
| hybrid (RRF k=60) | **0.575** (23/40) | **0.775** | **0.702** | 0/8 |

**Where each method actually wins (Hit@1, per category, n=8 each):** semantic beats BM25 on paraphrases (0.625 vs 0.250) and numbers (0.625 vs 0.250); BM25 beats semantic on exact identifiers (0.875 vs 0.750) **and negations (0.625 vs 0.375 — a semantic loss, kept)**; cross-project ties at 0.500. Every per-query row and failure is in `bench/results.json`.

**Honest failure — abstention is impossible here.** Best-match cosine scores for no-answer queries (0.37–0.66) overlap answerable scores (0.27–0.67), so *no* threshold separates them — see `abstention_sweep`. The app therefore never auto-declares absence; it lowers a noise floor (τ=0.25) and always shows scores so a human can judge.

**Tuning disclosure (not held-out).** τ was tuned on the same frozen set after inspecting a first exploratory run (τ=0.42 → 0.25); a frozen corpus does not make tuning held-out. The *original* τ=0.42 raw output file was overwritten and is **lost** — observed console values are recorded in `docs/TUNING.md`. A later re-run at τ=0.42 is preserved at `bench/archival/results-exploratory-tau042.json` (a re-run, not the original). An older τ=0.25 report on a pre-final chunker (38 chunks) is preserved at `bench/archival/results-tau025-38chunk-pre-final.json`. The table above comes from the final-code run at `bench/results.json`, whose `fingerprints` section records exact code/corpus/model/threshold hashes. See `bench/CORRECTIONS.md` for the full correction manifest.

**Caveats:** the corpus is fictional and small; the question set was written by the same AI that built the app; results measure retrieval on this packet, not real-world accuracy. No-answer false positives (returning results on unanswerable queries) are kept, not hidden.

## Measured performance

| context | measurement |
|---|---|
| Node 24, 8× Xeon Platinum 8559C VM | model load ~0.4 s · index 40 chunks ~0.11 s · ~1 ms/query |
| Chromium (Playwright, same VM) — cold | enable→ready **~1.8 s** incl. ~26.9 MB download + WASM compile; all receipts auto-linked ~3.2 s |
| Chromium — warm reload | enable→ready **~0.8 s** (model from browser cache) |
| semantic query | ~41 ms |

Only Chromium was tested; Firefox/Safari/WebGPU paths are untested.

## Known limitations (disclosed, unfixed)

- Sources are keyed by filename: importing another file with the same name
  replaces it (and marks linked evidence stale). Use unique filenames —
  e.g. include project/version/commit — to keep multiple revisions side by
  side.
- A verdict click followed by a page close within ~0.3 s can still lose that
  approval — fails safe (the verdict is absent, never misapplied to changed
  evidence).
- Deleting a source then re-adding a byte-identical file restores the old
  confirmation alongside the stale chip — fingerprints match again by
  design; the stale chip still signals the packet changed.
- JSON export records a claim's `sourceId` but not `sourceLine`; one question
  receipt can cite a partial line range.

## Develop

```bash
npm ci
npm run assets     # fetch pinned model + ORT wasm into public/ (~27 MB, sha256-verified)
npm run dev        # vite dev server
npm run build      # tsc --noEmit + vite build → dist/ (fully static)
npm test           # vitest unit tests (48)
npx playwright test  # e2e incl. a real in-browser model load (16)
```

The compact source archive (the `Source ↓` link on the demo, or
`claim-ledger-source.zip`) intentionally omits `public/models/` and
`public/ort/` binaries. After extracting: `npm ci && npm run assets` —
`scripts/fetch-assets.sh` downloads the six model files from Hugging Face at
the pinned revision `e6ac24e5…` and copies the four ORT files from the
package-lock-pinned `onnxruntime-web`, verifying each file's sha256 against a
hard-coded list; it fails loudly on any mismatch.

Deploy: `dist/` is fully static — any host works. A GitHub Actions workflow (`pages.yml`) deploys to Pages on push; `ci.yml` runs typecheck, unit and e2e; `bench.yml` reruns the frozen benchmark and uploads `results.json`.

## License & attribution

- App code: Apache-2.0 (see `LICENSE`).
- Model `mxbai-embed-xsmall-v1`: Apache-2.0, © mixedbread.ai — pinned revision above; not shipped in the source archive (fetched + hash-verified by `scripts/fetch-assets.sh`).
- `@huggingface/transformers` Apache-2.0; `onnxruntime-web` MIT (WASM copied to `public/ort/` by the same script).
- The bundled `public/sample/` corpus is entirely fictional — any resemblance to real projects is coincidental.

## Build record

Builder session began ~2026-10-02T02:19:33Z (approx, per session record); first local commit `3eba768` at 2026-10-02T02:59:43Z — that commit postdates all tuning runs, so no claim corpus was *committed* before tuning. What is demonstrable: `bench/queries.jsonl` was written and sha256-hashed in the working tree before the τ change was inspected (hash `16b5c516…` recorded in `bench/QUERIES.sha256`). Commit SHAs are reported as claimed until the GitHub repository is reachable and history can be verified — the workspace currently has no GitHub connection (push denied). Free static demo: https://dist-fbysspjc.devinapps.com
