import type { Claim, ReviewQuestion, SourceDoc } from "./types";

const DB = "claim-ledger";
const VERSION = 1;

export interface Persisted {
  sources: SourceDoc[];
  claims: Claim[];
  questions: ReviewQuestion[];
  epoch: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function loadState(): Promise<Persisted | null> {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get("state");
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  } catch {
    return null;
  }
}

let lastState: Persisted | null = null;
let writeChain: Promise<void> = Promise.resolve();
// writes are serialized immediately — a debounced save could lose the last
// mutation (verdict, source replace) when the page closes or reloads quickly
export function saveState(state: Persisted) {
  lastState = state;
  writeChain = writeChain.then(async () => {
    try {
      const db = await open();
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(state, "state");
    } catch { /* persistence is best-effort */ }
  });
}

/** last-chance flush on pagehide — IDB put issued while the document is still
 *  alive usually lands even though the page is unloading */
export function flushOnUnload() {
  if (!lastState) return;
  void open().then((db) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(lastState, "state");
  }).catch(() => {});
}

export async function clearState() {
  try {
    const db = await open();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete("state");
  } catch { /* noop */ }
}
