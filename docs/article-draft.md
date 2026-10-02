---
title: "Claim Ledger — a local AI review desk that shows its receipts"
published: false
tags: devchallenge, weekendchallenge, hf26challenge, webdev
---

> **SUPERSEDED / ARCHIVAL — do not publish as the current article.**
> This draft predates the integrity and packaging repair rounds and contains
> obsolete claims, preserved below for history only. Authoritative guidance:
> `README.md` and `bench/CORRECTIONS.md`. Obsolete statements include:
>
> - "the model is vendored in the repo … `npm ci && npm run dev`" reproduces
>   the AI — binaries are NOT in the source archive; `npm run assets`
>   (pinned, sha256-verified) is required after `npm ci`.
> - "no third party ever sees the handoff being reviewed" — overstated: the
>   initial site, runtime, model and asset downloads contact the static host
>   and Hugging Face, exposing ordinary network metadata; only imported text
>   and questions stay in the browser.
> - the benchmark freeze/"before any threshold was touched" chronology is
>   overstated — the working-tree query hash predates the τ decision, but no
>   benchmark files were committed before tuning (first commit postdates all
>   tuning runs); see README's Build record.
>
> The final publication draft is maintained separately by the owner.
> ---


> **Fully Autonomous AI construction — read this first.** This project was researched, designed, implemented, tested, benchmarked, recorded and written by AI agents (Devin, by Cognition) under the owner's direction, during the challenge window. No human wrote the code. The tests and benchmark numbers below are machine QA — honest measurements, not human feedback. The owner directed the work.

## What I Built

**Claim Ledger** is a local-first review desk for a very specific person: the teammate who gets handed someone else's project — a README, setup notes, some test records, a limitations file — and has to decide *what to actually verify*.

The owner's real teammate does second-pass review on project handoffs — that role exists, and handoff complexity is what motivated this tool. (The teammate hasn't used it yet; there is no usage feedback to report.) So the tool had to answer one question honestly: *"for each thing this packet claims, where's the receipt?"*

Here's the loop it builds:

1. **Load a packet.** Import `.txt`/`.md` docs (or paste), tagged by type — author documentation, supplied test records, stated limitations. Or click one button for a labelled fictional 3-project example.
2. **Get claims.** Claim-like lines ("max 2 concurrent syncs", "capped at 2 MB", "requires network") are pulled out automatically — or type your own.
3. **Find receipts.** Each claim is matched against source chunks and returned as exact excerpts — file, line range, content hash, retrieval mode, score. A small open embedding model ranks semantic similarity *in a Web Worker on your CPU*; BM25 keywords and a hybrid ranker are always available and always labelled.
4. **You decide.** The app never marks anything confirmed or refuted. Every claim gets a human verdict — confirmed / refuted / follow-up / not checked — plus a reviewer note.
5. **Hand it off.** Export a Markdown or JSON packet with quoted receipts, sha256 fingerprints, retrieval modes and an explicit *"retrieval is not verification"* footer. The next reviewer sees exactly what you checked and why.

The thing I wanted it to *never* do: answer in prose, or declare that evidence doesn't exist. Similarity can't prove a negative. When a claim has no close match, the UI says **"No linked receipt yet — no strong match, inspect sources"** — it doesn't pretend absence. Source labels are what the user said they are, not AI-certified facts. Reviewer observations stay separate from imported text. Edit or remove a source and every stale receipt is visibly marked.

## Demo

- **Live app (free static hosting):** https://dist-fbysspjc.devinapps.com
- **Code:** https://github.com/sharonbasovich/claim-ledger
- **Video (60–120s walkthrough):** https://app.devin.ai/attachments/87634b3c-84cf-42a0-b309-8dac52b874bf/claim-ledger-demo-69s.mp4

The one-click fictional packet makes the problem obvious in ~20 seconds: 12 docs across three imaginary projects, 39 claims extracted, receipts one click away.

## Code

https://github.com/sharonbasovich/claim-ledger — Apache-2.0, fully static, `npm ci && npm run dev`. The model is vendored in the repo (`public/models/`, revision-pinned), so a clone reproduces the whole thing offline after the first static download. CI runs typecheck + unit + a Playwright suite that includes a *real* in-browser model load; a separate workflow re-runs the frozen benchmark.

## How I Built It

**Stack:** Vite + TypeScript (strict), vanilla DOM, no framework, IndexedDB persistence, service worker for the app shell. ONNX Runtime Web on WASM/CPU only — no WebGPU, no GPU requirements.

**Model:** `mixedbread-ai/mxbai-embed-xsmall-v1` (Apache-2.0), q8 ONNX, ~24.4 MB — small enough to download on a cable connection, big enough to mean something. Mean-pooled, L2-normalized 384-dim embeddings via `@huggingface/transformers` 4.3.0, running in a dedicated Web Worker so the UI never blocks.

**The engineering that mattered:**

- **Real retrieval, not vibes.** BM25 is a genuine implementation (k1=1.5, b=0.75) over the same paragraph-aware chunks the embedder sees (≤400 approx-tokens, 1-based line ranges, sha256 fingerprints). Hybrid merges rankings with reciprocal-rank fusion — every receipt chip says which method produced it.
- **A frozen benchmark before the threshold decision.** 48 AI-drafted queries over the fictional corpus — paraphrases, exact identifiers, negations, numbers, ambiguity, no-answer traps, cross-project confusion — hashed (`bench/QUERIES.sha256`) before any threshold was touched.
- **Honesty as a feature.** An opt-in enable button with a live byte counter, cancel/retry, a permanently-labelled keyword-only fallback, epoch-based invalidation so stale links can't masquerade as fresh evidence, and plain-text rendering for every imported doc (link schemes sanitized — `javascript:` URLs render as inert text).

## Measured: a real win and an honest failure

On the frozen 48-query set (Node 24, q8 model):

| method | Hit@1 | Hit@3 | MRR |
|---|---|---|---|
| BM25 | 0.500 | 0.775 | 0.642 |
| **semantic** | **0.575** | 0.725 | 0.694 |
| hybrid (RRF) | **0.575** | **0.775** | **0.702** |

Semantic wins where it should: paraphrases (0.625 vs 0.250 Hit@1 — "what happens when the network disappears" → the offline-sync paragraph, zero shared tokens) and numbers (0.625 vs 0.250). But it *loses* where it should too: BM25 beats it on exact identifiers (0.875 vs 0.750) and negations (0.625 vs 0.375). That loss stays in the table — it's why the UI offers all three modes rather than selling "AI search".

**The honest failure:** abstention doesn't work. I wanted "no strong match" to be trustworthy on unanswerable questions. It isn't: no-answer queries score 0.37–0.66 in best-match cosine, overlapping answerable scores (0.27–0.67). The full threshold sweep in `bench/results.json` shows no cutoff separates them. So the app *never* auto-declares absence — the abstain is a noise-floor hint plus always-visible scores for the human.

One more disclosure, because it would be easy to gloss over: the final abstention floor (τ=0.25) was tuned *after* looking at results on this same frozen set — exploratory, not held-out. The original τ=0.42 raw output was overwritten and is lost; a later re-run is preserved (`bench/archival/results-exploratory-tau042.json`) alongside the correction manifest (`bench/CORRECTIONS.md`), and every query-level result and failure ships in the final-code `bench/results.json`.

**Speed, measured on the build machine** (8-core Xeon VM, Chromium): cold enable→ready ~1.8s including the ~27MB model+runtime download; ~41ms per semantic query; warm reload ~0.8s from the browser cache. A separate reviewer's cloud Chrome measured a 4.9s model load — one environment with unknown cache state, not a general claim. No claims about phones — untested.

## Why Does Open Innovation Matter?

Because the *reason* this app can be honest is that everything is inspectable.

An API-key demo could have hidden a huge model behind a "magic" box — but then the claim "it never verifies truth, it only ranks snippets" would be unverifiable too. An Apache-2.0 embedding model vendored in the repo, a benchmark you can rerun, source you can read, and inference you can watch in DevTools' network tab mean the trust story is checkable, not rhetorical. Open weights are what let a ~24MB model run privately on the machine where the confidential packet already lives — no third party ever sees the handoff being reviewed.

Local-first AI isn't a compromise here; it's the whole point. The packet stays in the browser. The model comes to the data.

## Limitations

- Corpus in the demo is fictional and small; benchmark measures retrieval on that packet, not real-world accuracy.
- The query set was written by the same AI that built the app — a real blind spot.
- Abstention is a heuristic, not a guarantee (see above — deliberately).
- Tested in Chromium only; Firefox/Safari untested. Chunking is paragraph/line based and English-tuned; non-Latin text works but is barely covered by tests.
- The model is English-first; big docs are chunked, so cross-paragraph reasoning is out of scope — by design, it ranks receipts, not reasoning.

## Prize Categories

Hacktoberfest Weekend Challenge only — no partner categories.

---

*Tags: #devchallenge #weekendchallenge #hf26challenge*
