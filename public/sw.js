/* Claim Ledger service worker: cache-first for same-origin GETs so the app
 * keeps working offline after the first load.
 *
 * The cache name is derived from the hash of index.html, so every redeploy
 * produces a fresh cache and stale builds can never leak into a repaired
 * release. The activate step deletes only this app's own cl-* caches —
 * user work lives in IndexedDB and is never touched. */
let cacheNamePromise = null;
function cacheName() {
  cacheNamePromise ??= (async () => {
    const res = await fetch("./index.html", { cache: "no-store" }).catch(() => null);
    const bytes = res && res.ok ? await res.arrayBuffer() : new Uint8Array().buffer;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `cl-${hex}`;
  })();
  return cacheNamePromise;
}

self.addEventListener("install", (e) => {
  e.waitUntil(cacheName().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const current = await cacheName();
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => (k.startsWith("cl-") || k === "claim-ledger-v1") && k !== current)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Model binaries + ONNX runtime are fetched by transformers.js in a Web Worker
  // and are persisted by its own browser cache; proxying them here corrupts
  // aborted/streamed responses, so let them go straight to network.
  const base = new URL(".", self.registration.scope).pathname;
  if (url.pathname.startsWith(`${base}models/`) || url.pathname.startsWith(`${base}ort/`)) return;
  // The SW script itself and the HTML shell always revalidate, so a redeploy
  // is picked up immediately instead of serving the stale cached build.
  const isShell = e.request.mode === "navigate" || url.pathname.endsWith("/sw.js");
  e.respondWith(cacheName().then(async (name) => {
    const cache = await caches.open(name);
    if (isShell) {
      try {
        const res = await fetch(e.request, { cache: "no-cache" });
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch (err) {
        const shell = await cache.match("./index.html") || await cache.match("./");
        if (shell) return shell;
        throw err;
      }
    }
    const hit = await cache.match(e.request);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      throw err;
    }
  }));
});
