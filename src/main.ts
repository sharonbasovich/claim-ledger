import "./style.css";
import { BM25Index, tokenize } from "./bm25";
import { buildChunks, sha256Hex } from "./chunker";
import { claimFromExtracted, extractClaims, newClaimId } from "./claims";
import { EmbedClient } from "./embed";
import { exportJSON, exportMarkdown, MODEL_ID, evidenceKey, effectiveStatus, verdictOf } from "./export";
import { clearState, flushOnUnload, loadState, saveState } from "./storage";
import { rankBM25, rankHybrid, rankSemantic, toReceipts, type RankedResult } from "./search";
import type {
  Chunk, Claim, ModelState, RetrievalMode, ReviewQuestion, ReviewStatus, SourceDoc, SourceType,
} from "./types";

const SOURCE_TYPES: SourceType[] = ["readme", "setup", "demo", "tests", "limits", "notes"];
const TYPE_LABEL: Record<SourceType, string> = {
  readme: "Author docs", setup: "Author docs", demo: "Author docs",
  tests: "Supplied test record", limits: "Known limitations", notes: "Notes",
};
const STATUS_LABEL: Record<ReviewStatus, string> = {
  not_checked: "Not checked", confirmed: "Confirmed", refuted: "Refuted", follow_up: "Follow-up",
};
const SAMPLE_FILES = [
  ["trailmend/README.md", "readme"], ["trailmend/SETUP.md", "setup"],
  ["trailmend/TESTS.md", "tests"], ["trailmend/LIMITS.md", "limits"],
  ["pantrypal/README.md", "readme"], ["pantrypal/SETUP.md", "setup"],
  ["pantrypal/TESTS.md", "tests"], ["pantrypal/LIMITS.md", "limits"],
  ["inkwell/README.md", "readme"], ["inkwell/SETUP.md", "setup"],
  ["inkwell/TESTS.md", "tests"], ["inkwell/LIMITS.md", "limits"],
] as const;

// transformers.js local-model fetches must be plain paths (its metadata check skips
// absolute URLs); onnxruntime's wasmPaths want full URLs.
const MODEL_PATH = new URL("models/", window.location.href).pathname;
const ONNX_PATH = new URL("ort/", window.location.href).href;
const PREFILL_QUESTIONS = [
  "Can I use the trail planner on a plane with no signal?",
  "What is known to be broken or failing?",
  "What are the stated usage limits?",
  "What did the supplied tests actually cover?",
];

interface AppState {
  sources: SourceDoc[];
  claims: Claim[];
  questions: ReviewQuestion[];
  epoch: number;
  projectName: string;
}

const state: AppState = { sources: [], claims: [], questions: [], epoch: 0, projectName: "Untitled packet" };
let chunks: Chunk[] = [];
let bm25 = new BM25Index([]);
let embeddings: Float32Array[] | null = null;
let embedEpoch = -1;            // epoch the embeddings were built against
let searching = 0;              // in-flight search count (for "searching…" hint)
let askMode: "auto" | RetrievalMode = "auto";
const embed = new EmbedClient();

// ---------- helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, kids: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("data-")) n.setAttribute(k, v);
    else if (k === "value") (n as HTMLInputElement).value = v;
    else if (k === "disabled" && v === "") (n as HTMLButtonElement).disabled = true;
    else n.setAttribute(k, v);
  }
  for (const c of kids) n.append(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

function fmtBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function persist() {
  saveState({ sources: state.sources, claims: state.claims, questions: state.questions, epoch: state.epoch });
}

async function rebuildIndex() {
  const out: Chunk[] = [];
  for (const s of state.sources) out.push(...await buildChunks(s));
  chunks = out;
  bm25 = new BM25Index(chunks.map((c) => ({ id: c.id, tokens: chunkTokens(c) })));
  embeddings = null;
}

function chunkTokens(c: Chunk): string[] { return tokenize(c.text); }

async function bumpEpoch() {
  state.epoch++;
  embeddings = null;
  embedEpoch = -1;
  await rebuildIndex();
  persist();
  render();
}

function chunkMap(): Map<string, Chunk> {
  return new Map(chunks.map((c) => [c.id, c]));
}

function mode(): RetrievalMode {
  if (askMode !== "auto") return askMode;
  return embed.ready ? "hybrid" : "bm25";
}

// ---------- corpus mutations ----------

async function addSource(fileName: string, text: string, type: SourceType, provenance: string) {
  const doc: SourceDoc = {
    id: fileName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `doc-${Date.now()}`,
    fileName, type, provenance, text,
    sha256: await sha256Hex(text), addedAt: Date.now(),
  };
  // de-dupe: same filename+hash is a no-op; same filename different text replaces
  const existing = state.sources.findIndex((s) => s.fileName === fileName);
  if (existing >= 0 && state.sources[existing].sha256 === doc.sha256) return;
  if (existing >= 0) state.sources.splice(existing, 1);
  state.sources.push(doc);
  await bumpEpoch();
}

async function removeSource(id: string) {
  state.sources = state.sources.filter((s) => s.id !== id);
  await bumpEpoch();
}

async function resetAll() {
  state.sources = []; state.claims = []; state.questions = [];
  state.projectName = "Untitled packet";
  embed.cancel(); // in-flight worker results die with the reset
  await clearState();
  await bumpEpoch();
}

async function loadSample() {
  for (const [path, type] of SAMPLE_FILES) {
    const res = await fetch(`./sample/${path}`);
    const text = await res.text();
    await addSource(path, text, type, "Fictional example packet (synthetic data)");
  }
  state.projectName = "Example packet — three fictional projects";
  await extractClaimsFromDocs();
  persist(); render();
}

// ---------- claims ----------

async function extractClaimsFromDocs() {
  const found = extractClaims(state.sources);
  const existing = new Set(state.claims.map((c) => c.text.trim().toLowerCase()));
  let added = 0;
  for (const f of found) {
    if (existing.has(f.text.trim().toLowerCase())) continue;
    state.claims.push(claimFromExtracted(f, state.epoch));
    added++;
  }
  return added;
}

let embedChunkIds = "";

/** Embed `chunkSnap` — the caller's immutable snapshot of the corpus index.
 *  If the corpus changes (any epoch bump) while vectors are in flight, the late
 *  result is discarded and the call reports failure, so embeddings are never
 *  tagged with a generation they don't match. */
async function ensureEmbeddings(chunkSnap: Chunk[], epoch: number): Promise<boolean> {
  if (!embed.ready) return false;
  const ids = chunkSnap.map((c) => `${c.id}:${c.sha256.slice(0, 8)}`).join(",");
  if (embeddings && embedEpoch === epoch && embedChunkIds === ids) return true;
  const delay = (window as unknown as { __cl_embedDelayMs?: number }).__cl_embedDelayMs;
  if (delay) await new Promise((r) => setTimeout(r, delay)); // test hook: widen the race window
  const embs = await embed.embed(chunkSnap.map((c) => c.text));
  if (state.epoch !== epoch) return false;
  embeddings = embs;
  embedEpoch = epoch;
  embedChunkIds = ids;
  return true;
}

async function findReceipts(claim: Claim) {
  const epoch = state.epoch;
  const chunkSnap = chunks;
  const bm25Snap = bm25;
  const m = mode();
  let r: RankedResult;
  if (m === "semantic" || m === "hybrid") {
    if (!(await ensureEmbeddings(chunkSnap, epoch))) {
      if (state.epoch !== epoch) return; // corpus changed mid-flight — drop late results
      r = rankBM25(bm25Snap, chunkSnap, claim.text, 3); // model unavailable — keyword fallback
    } else {
      const [q] = await embed.embed([claim.text]);
      if (state.epoch !== epoch) return;
      r = m === "semantic"
        ? rankSemantic(chunkSnap, embeddings!, q, 3)
        : rankHybrid(bm25Snap, chunkSnap, embeddings!, claim.text, q, 3);
    }
  } else {
    r = rankBM25(bm25Snap, chunkSnap, claim.text, 3);
    if (state.epoch !== epoch) return;
  }
  claim.receipts = r.abstained ? [] : toReceipts(r.hits);
  claim.receiptEpoch = epoch;
  claim.searchedEpoch = epoch;
  claim.updatedAt = Date.now();
}

async function findAllReceipts() {
  for (const c of state.claims) await findReceipts(c);
  persist(); render();
}

// ---------- model control ----------

embed.onState = (_s: ModelState) => renderHeader();

async function enableModel() {
  try {
    await embed.enable(MODEL_PATH, ONNX_PATH);
    await findAllReceipts();
  } catch (e) {
    if ((e as Error).message !== "cancelled") console.warn("model load failed:", (e as Error).stack ?? e);
    render();
  }
}

// ---------- questions ----------

async function ask(text: string) {
  if (!text.trim()) return;
  const q: ReviewQuestion = {
    id: `q-${Date.now().toString(36)}`, text: text.trim(), askedAt: Date.now(),
    epoch: state.epoch, results: [], abstained: false, note: "",
  };
  state.questions.unshift(q);
  render();
  const myEpoch = state.epoch;
  const chunkSnap = chunks;
  const bm25Snap = bm25;
  searching++;
  try {
    const m = mode();
    let r: RankedResult;
    if ((m === "semantic" || m === "hybrid") && await ensureEmbeddings(chunkSnap, myEpoch)) {
      if (myEpoch !== state.epoch) return;
      const [qe] = await embed.embed([q.text]);
      if (myEpoch !== state.epoch) return; // corpus changed mid-flight — drop late results
      r = m === "semantic"
        ? rankSemantic(chunkSnap, embeddings!, qe, 5)
        : rankHybrid(bm25Snap, chunkSnap, embeddings!, q.text, qe, 5);
    } else {
      if (myEpoch !== state.epoch) return;
      r = rankBM25(bm25Snap, chunkSnap, q.text, 5);
    }
    if (myEpoch !== state.epoch) return;
    q.results = toReceipts(r.hits);
    q.abstained = r.abstained;
  } finally {
    searching--;
  }
  persist(); render();
}

// ---------- export ----------

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- rendering ----------

const app = document.getElementById("app")!;

function renderHeader() {
  const host = document.getElementById("modelctl");
  if (!host) return;
  host.textContent = "";
  const s = embed.state;
  if (s.status === "off") {
    const btn = el("button", { class: "btn btn-primary", id: "enable-model" },
      ["Enable on-device AI ranking"]);
    btn.onclick = () => void enableModel();
    host.append(btn, el("span", { class: "hint" },
      [`downloads ~27 MB model + runtime once from this host · your docs stay in this browser`]));
    if (s.cancelled) host.append(el("span", { class: "hint" }, ["download cancelled"]));
  } else if (s.status === "downloading" || s.status === "loading") {
    const pct = s.bytesTotal ? Math.round((s.bytesLoaded / s.bytesTotal) * 100) : 0;
    const bar = el("div", { class: "progress" }, [el("div", { class: "progress-fill", style: `width:${pct}%` })]);
    const cancel = el("button", { class: "btn", id: "cancel-model" }, ["Cancel"]);
    cancel.onclick = () => embed.cancel();
    host.append(el("div", { class: "dl" }, [
      bar,
      el("span", { class: "hint" }, [`${fmtBytes(s.bytesLoaded)}${s.bytesTotal ? " / " + fmtBytes(s.bytesTotal) : ""} · from this site`]),
      cancel,
    ]));
  } else if (s.status === "ready") {
    host.append(el("span", { class: "chip chip-ok" }, [
      `AI ranking on · ${MODEL_ID.split("/")[1]} q8 · loaded in ${((s.loadMs ?? 0) / 1000).toFixed(1)}s`,
    ]));
  } else {
    const retry = el("button", { class: "btn" }, ["Retry"]);
    retry.onclick = () => void enableModel();
    host.append(el("span", { class: "chip chip-err" }, [`Model failed: ${s.error ?? "unknown"}`]), retry,
      el("span", { class: "hint" }, ["keyword search still works"]));
  }
}

function renderSources(): HTMLElement {
  const lane = el("section", { class: "lane", id: "lane-sources" });
  lane.append(el("h2", {}, ["Packet sources"]), el("p", { class: "lane-hint" },
    ["The documents under review. Labels are what the sender said — not AI-verified."]));

  const loadBtn = el("button", { class: "btn btn-primary" }, ["Load fictional example packet"]);
  loadBtn.onclick = () => void loadSample();
  lane.append(el("div", { class: "row" }, [loadBtn,
    el("span", { class: "hint" }, ["12 docs · 3 synthetic projects · one click"])]));

  // import
  const file = el("input", { type: "file", class: "visually-hidden", accept: ".txt,.md,.markdown,text/plain,text/markdown", multiple: "", tabindex: "-1", "aria-hidden": "true" });
  file.onchange = async () => {
    for (const f of Array.from(file.files ?? [])) {
      const text = await f.text();
      await addSource(f.name, text, "notes", "");
    }
    file.value = "";
  };
  const importBtn = el("button", { class: "btn", id: "import-files" }, ["Import .txt/.md files"]);
  importBtn.onclick = () => file.click();
  lane.append(el("div", { class: "row" }, [importBtn, file]));

  const paste = el("textarea", { class: "paste", placeholder: "…or paste document text here", rows: "3" });
  const typeSel = el("select", { class: "sel" }, SOURCE_TYPES.map((t) =>
    el("option", { value: t }, [t.toUpperCase()])));
  const prov = el("input", { class: "inp", placeholder: "Provenance (optional): who sent it, when" });
  const nameInp = el("input", { class: "inp", placeholder: "File name, e.g. README.md" });
  const addBtn = el("button", { class: "btn" }, ["Add document"]);
  addBtn.onclick = async () => {
    const text = paste.value;
    if (!text.trim()) return;
    await addSource(nameInp.value.trim() || `pasted-${state.sources.length + 1}.md`,
      text, typeSel.value as SourceType, prov.value.trim());
    paste.value = ""; nameInp.value = "";
  };
  lane.append(el("div", { class: "stack" }, [paste,
    el("div", { class: "row" }, [nameInp, typeSel]), prov, addBtn]));

  // doc list
  const list = el("div", { class: "doclist" });
  for (const s of state.sources) {
    const nChunks = chunks.filter((c) => c.sourceId === s.id).length;
    const del = el("button", { class: "btn btn-ghost btn-sm" }, ["Remove"]);
    del.onclick = () => void removeSource(s.id);
    list.append(el("div", { class: "doc" }, [
      el("div", { class: "doc-head" }, [
        el("span", { class: "doc-name" }, [s.fileName]),
        el("span", { class: `chip chip-${s.type}` }, [s.type.toUpperCase()]),
      ]),
      el("div", { class: "doc-meta" }, [
        `${s.text.length.toLocaleString()} chars · ${nChunks} chunks · sha256 ${s.sha256.slice(0, 10)}`,
      ]),
      s.provenance ? el("div", { class: "doc-prov" }, [s.provenance]) : "",
      el("details", { class: "doc-detail" }, [
        el("summary", {}, ["Full text"]),
        el("pre", { class: "doc-text" }, [s.text]),
      ]),
      del,
    ]));
  }
  lane.append(list);

  const reset = el("button", { class: "btn btn-danger btn-sm" }, ["Reset packet"]);
  reset.onclick = () => void resetAll();
  lane.append(el("div", { class: "row" }, [reset]));
  return lane;
}

function receiptNode(r: Claim["receipts"][number], stale: boolean): HTMLElement {
  const cm = chunkMap();
  const ch = cm.get(r.chunkId);
  const wrap = el("div", { class: `receipt ${stale ? "stale" : ""}` });
  // fingerprint check: never render replacement text under an old score
  if (!ch || ch.sha256 !== r.chunkSha256 || ch.sourceSha256 !== r.sourceSha256) {
    wrap.append(el("span", { class: "hint" }, [`receipt ${r.chunkId} — ${!ch ? "source removed" : "source changed since link — run Find receipts again"}`]));
    return wrap;
  }
  const srcDoc = state.sources.find((d) => d.id === ch.sourceId);
  wrap.append(
    el("div", { class: "receipt-text" }, [ch.text]),
    el("div", { class: "receipt-meta" }, [
      `${ch.fileName}:${ch.lineStart}–${ch.lineEnd}`,
      el("span", { class: `chip chip-mode-${r.mode}` }, [r.mode]),
      el("span", { class: "hint" }, [`score ${r.score.toFixed(3)}`]),
      el("span", { class: `chip chip-${ch.sourceType}` }, [TYPE_LABEL[ch.sourceType]]),
    ]),
  );
  if (srcDoc) {
    const view = el("details", { class: "src-view" }, [
      el("summary", {}, [`View source — ${ch.fileName} (lines ${ch.lineStart}–${ch.lineEnd} of ${srcDoc.text.split("\n").length})`]),
      el("pre", { class: "src-full" }, [srcDoc.text]),
    ]);
    wrap.append(view);
  }
  return wrap;
}

function renderClaims(): HTMLElement {
  const lane = el("section", { class: "lane", id: "lane-claims" });
  const withReceipts = state.claims.filter((c) => c.receipts.length > 0).length;
  const cmForStatus = chunkMap();
  const checked = state.claims.filter((c) => effectiveStatus(c, cmForStatus) !== "not_checked").length;
  lane.append(el("h2", {}, ["Claims"]),
    el("p", { class: "lane-hint" }, [
      `Claims with candidate receipts: ${withReceipts}/${state.claims.length} · reviewer-checked: ${checked}/${state.claims.length}`,
    ]),
    el("p", { class: "lane-hint" }, ["The model ranks candidate receipts. Only you set the verdict."]));

  const extractBtn = el("button", { class: "btn" }, ["Extract claims from docs"]);
  extractBtn.onclick = async () => { await extractClaimsFromDocs(); persist(); render(); };
  const refreshBtn = el("button", { class: "btn" }, [embed.ready ? "Refresh all receipts" : "Find receipts (keywords)"]);
  refreshBtn.onclick = () => void findAllReceipts();
  const addBtn = el("button", { class: "btn" }, ["+ Add claim"]);
  addBtn.onclick = () => {
    state.claims.unshift({
      id: newClaimId(), text: "", origin: "manual", status: "not_checked",
      note: "", receipts: [], receiptEpoch: state.epoch, updatedAt: Date.now(),
    });
    render();
  };
  lane.append(el("div", { class: "row" }, [extractBtn, refreshBtn, addBtn]));

  for (const c of state.claims) {
    const stale = c.receiptEpoch !== state.epoch && c.searchedEpoch !== undefined;
    const card = el("div", { class: "claim", id: c.id });

    const textEl = c.origin === "manual" && !c.text
      ? el("textarea", { class: "claim-edit", placeholder: "Type the claim to check…", rows: "2" })
      : el("div", { class: "claim-text" }, [c.text]);
    if (textEl instanceof HTMLTextAreaElement) {
      textEl.onchange = () => {
        // an edited claim is a new claim: prior verdict and receipts cannot
        // silently carry over to text the reviewer never approved
        c.text = textEl.value;
        c.status = "not_checked"; delete c.statusText; delete c.statusEvidence;
        c.receipts = []; delete c.searchedEpoch;
        c.updatedAt = Date.now(); persist(); render();
      };
    }

    const badge = el("span", { class: `chip chip-${c.origin}` },
      [c.origin === "author" ? "Author claim" : "Reviewer claim"]);
    const srcGone = c.sourceId !== undefined && !state.sources.some((s) => s.id === c.sourceId);
    const srcChip = c.sourceId !== undefined
      ? el("span", { class: `chip ${srcGone ? "chip-stale" : "chip-src"}` },
        [srcGone ? "source removed" : `${c.sourceId}${c.sourceLine ? ":" + c.sourceLine : ""}`])
      : "";
    card.append(el("div", { class: "claim-head" }, [badge, srcChip,
      stale ? el("span", { class: "chip chip-stale" }, ["receipts stale — packet changed"]) : ""]));

    card.append(textEl);

    // receipts
    const rwrap = el("div", { class: "receipts" });
    const searchedCurrent = c.searchedEpoch === state.epoch;
    if (c.receipts.length === 0) {
      rwrap.append(el("div", { class: "noreceipt" }, [searchedCurrent
        ? "No strong match — inspect sources."
        : "No linked receipt yet."]));
      const findBtn = el("button", { class: "btn btn-sm" }, ["Find receipts"]);
      findBtn.onclick = async () => { await findReceipts(c); persist(); render(); };
      rwrap.append(findBtn);
    } else {
      rwrap.append(el("div", { class: "hint sr-hint" },
        ["Ranked by similarity — a candidate, not proof. Verify against the source."]));
      c.receipts.forEach((r) => rwrap.append(receiptNode(r, stale)));
      const again = el("button", { class: "btn btn-sm btn-ghost" }, ["Re-rank"]);
      again.onclick = async () => { await findReceipts(c); persist(); render(); };
      rwrap.append(again);
    }
    card.append(rwrap);

    // reviewer controls
    const verdict = verdictOf(c, chunkMap());
    const effStatus = effectiveStatus(c, chunkMap());
    const statusRow = el("div", { class: "status-row" });
    for (const st of ["not_checked", "confirmed", "refuted", "follow_up"] as ReviewStatus[]) {
      const b = el("button", {
        class: `status-btn st-${st} ${effStatus === st ? "active" : ""}`,
      }, [STATUS_LABEL[st]]);
      b.setAttribute("aria-pressed", String(effStatus === st));
      b.onclick = () => { c.status = st; c.statusText = c.text; c.statusEvidence = evidenceKey(c, chunkMap()); c.updatedAt = Date.now(); persist(); render(); };
      statusRow.append(b);
    }
    card.append(el("div", { class: "status-wrap" }, [
      el("span", { class: "hint" }, ["Your call:"]), statusRow,
      // an invalid prior verdict is never silently renewed — fresh review required
      verdict && !verdict.valid
        ? el("div", { class: "hint verdict-stale" },
            [`prior verdict "${STATUS_LABEL[verdict.status]}" invalidated — ${verdict.reason}; re-review to confirm`])
        : "",
    ]));

    const note = el("input", { class: "inp note", placeholder: "Reviewer note (what you actually verified)", value: c.note });
    note.onchange = () => { c.note = note.value; c.updatedAt = Date.now(); persist(); };
    card.append(note);

    const del = el("button", { class: "btn btn-ghost btn-sm" }, ["Remove claim"]);
    del.onclick = () => { state.claims = state.claims.filter((x) => x.id !== c.id); persist(); render(); };
    card.append(del);
    lane.append(card);
  }
  return lane;
}

function renderAsk(): HTMLElement {
  const lane = el("section", { class: "lane", id: "lane-ask" });
  lane.append(el("h2", {}, ["Ask the packet"]),
    el("p", { class: "lane-hint" }, ["Questions stay on this device. Similarity ranks candidates — it isn't proof; an unrelated question can still return sources. Ranking mode:"]));

  const modes = el("div", { class: "seg" });
  for (const m of ["auto", "hybrid", "semantic", "bm25"] as const) {
    const label = m === "bm25" ? "keywords" : m;
    const b = el("button", { class: `seg-btn ${askMode === m ? "active" : ""}`, "aria-pressed": String(askMode === m) }, [label]);
    b.onclick = () => { askMode = m; render(); };
    modes.append(b);
  }
  lane.append(modes);

  const input = el("input", { class: "inp ask-inp", id: "ask-input",
    placeholder: "Ask in your own words — e.g. “can I use it offline?”" });
  const go = el("button", { class: "btn btn-primary" }, ["Ask"]);
  const run = () => { const v = input.value; input.value = ""; void ask(v); };
  go.onclick = run;
  input.onkeydown = (e) => { if (e.key === "Enter") run(); };
  lane.append(el("div", { class: "row" }, [input, go]));

  const chips = el("div", { class: "row wrap" });
  for (const p of PREFILL_QUESTIONS) {
    const b = el("button", { class: "btn btn-sm btn-ghost" }, [p]);
    b.onclick = () => void ask(p);
    chips.append(b);
  }
  lane.append(chips);

  for (const q of state.questions) {
    const card = el("div", { class: "q" });
    const stale = q.epoch !== state.epoch;
    card.append(el("div", { class: "q-text" }, [`“${q.text}”`,
      stale ? " · packet changed — ask again" : ""]));
    if (q.results.length === 0 && !q.abstained) {
      card.append(el("div", { class: "hint" }, [searching > 0 ? "searching…" : "no results recorded"]));
    } else if (q.abstained) {
      card.append(el("div", { class: "noreceipt" },
        ["No strong match — inspect sources. Similarity can’t prove a negative."]));
    }
    const cm = chunkMap();
    for (const r of q.results) {
      const ch = cm.get(r.chunkId);
      if (!ch || ch.sha256 !== r.chunkSha256 || ch.sourceSha256 !== r.sourceSha256) {
        card.append(el("div", { class: "hint" }, [`result ${r.chunkId} — ${!ch ? "source removed" : "source changed since search — ask again"}`]));
        continue;
      }
      const qSrc = state.sources.find((d) => d.id === ch.sourceId);
      const qWrap = el("div", { class: "receipt" }, [
        el("div", { class: "receipt-text" }, [ch.text]),
        el("div", { class: "receipt-meta" }, [
          `${ch.fileName}:${ch.lineStart}–${ch.lineEnd}`,
          el("span", { class: `chip chip-mode-${r.mode}` }, [r.mode]),
          el("span", { class: "hint" }, [`${r.score.toFixed(3)}`]),
        ]),
      ]);
      if (qSrc) {
        qWrap.append(el("details", { class: "src-view" }, [
          el("summary", {}, [`View source — ${ch.fileName} (lines ${ch.lineStart}–${ch.lineEnd} of ${qSrc.text.split("\n").length})`]),
          el("pre", { class: "src-full" }, [qSrc.text]),
        ]));
      }
      card.append(qWrap);
    }
    const note = el("input", { class: "inp note", placeholder: "Conclusion (yours)", value: q.note });
    note.onchange = () => { q.note = note.value; persist(); };
    card.append(note);
    lane.append(card);
  }

  // export
  const exMd = el("button", { class: "btn btn-primary" }, ["Export handoff (.md)"]);
  exMd.onclick = () => download(`${state.projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).toLowerCase() || "handoff"}-handoff.md`,
    exportMarkdown(state.sources, state.claims, state.questions, chunkMap(), state.projectName), "text/markdown");
  const exJson = el("button", { class: "btn" }, ["Export (.json)"]);
  exJson.onclick = () => download(`${state.projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).toLowerCase() || "handoff"}-handoff.json`,
    exportJSON(state.sources, state.claims, state.questions, chunkMap(), state.projectName), "application/json");
  lane.append(el("h2", {}, ["Handoff"]),
    el("p", { class: "lane-hint" }, ["Markdown or JSON with receipts, hashes and reviewer verdicts."]),
    el("div", { class: "row" }, [exMd, exJson]));
  return lane;
}

let root: HTMLElement;
function render() {
  root.textContent = "";
  const banner = !embed.ready
    ? el("div", { class: "banner" }, ["Keyword mode (no AI) — every result is labelled. Enable the model for semantic ranking."])
    : "";
  const header = el("header", {}, [
    el("div", { class: "titleblock" }, [
      el("h1", {}, ["Claim Ledger"]),
      el("p", { class: "sub" }, ["A local-first claim → receipt → review desk."]),
      el("p", { class: "sub sub-note" }, ["Docs & questions stay in this browser — the site, runtime and ~27 MB model download come from your hosting provider (ordinary network metadata applies)."]),
    ]),
    el("div", { id: "modelctl" }),
  ]);
  const nav = el("nav", { class: "lanenav" },
    [["Sources", "lane-sources"], ["Claims", "lane-claims"], ["Ask", "lane-ask"]].map(([label, id]) => {
      return el("a", { class: "navlink", href: `#${id}` }, [label]);
    }));
  nav.append(el("a", { class: "navlink", href: "./source/claim-ledger-source.zip", download: "claim-ledger-source.zip" }, ["Source ↓"]));
  header.append(nav);
  const board = el("main", { class: "board" }, [renderSources(), renderClaims(), renderAsk()]);
  root.append(header, ...(banner ? [banner] : []), board);
  renderHeader();
}

async function boot() {
  root = el("div", { id: "root" });
  app.append(root);
  const saved = await loadState();
  if (saved) {
    state.sources = saved.sources; state.claims = saved.claims;
    state.questions = saved.questions; state.epoch = saved.epoch;
  }
  await rebuildIndex();
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  document.addEventListener("pagehide", flushOnUnload);
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      document.getElementById("ask-input")?.focus();
    }
  });
}

void boot();
