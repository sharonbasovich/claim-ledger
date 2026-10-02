import type { ModelState } from "./types";

/** Main-thread client for the embedding worker. Cancel = terminate + respawn;
 *  a generation counter makes late messages from a dead worker harmless. */
export class EmbedClient {
  private worker: Worker | null = null;
  private gen = 0;
  private pending = new Map<number, { res: (v: Float32Array[]) => void; rej: (e: Error) => void }>();
  private initWaiter: { res: () => void; rej: (e: Error) => void } | null = null;
  private seq = 0;
  private progFiles = new Map<string, { loaded: number; total: number }>();
  state: ModelState = { status: "off", bytesLoaded: 0, bytesTotal: 0 };
  onState: (s: ModelState) => void = () => {};

  private set(patch: Partial<ModelState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  get ready() { return this.state.status === "ready"; }

  private spawn(modelPath: string, onnxPath: string) {
    const w = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
    const g = this.gen;
    w.onmessage = (ev) => {
      if (g !== this.gen) return; // late message from a cancelled worker
      const m = ev.data;
      if (m.type === "progress") {
        this.progFiles.set(m.file, { loaded: m.loaded, total: m.total ?? this.progFiles.get(m.file)?.total ?? 0 });
        let loaded = 0, total = 0;
        for (const f of this.progFiles.values()) { loaded += f.loaded; total += f.total; }
        this.set({ bytesLoaded: loaded, bytesTotal: total });
      } else if (m.type === "ready") {
        this.set({ status: "ready", loadMs: m.loadMs });
        this.initWaiter?.res();
        this.initWaiter = null;
      } else if (m.type === "embedded") {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.res(m.embeddings); }
      } else if (m.type === "error") {
        if (m.id != null && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!;
          this.pending.delete(m.id);
          p.rej(new Error(m.message));
        } else {
          this.set({ status: "error", error: m.message });
          this.initWaiter?.rej(new Error(m.message));
          this.initWaiter = null;
        }
      }
    };
    w.onerror = (e) => {
      if (g !== this.gen) return;
      this.set({ status: "error", error: e.message ?? "worker error" });
      this.initWaiter?.rej(new Error(e.message ?? "worker error"));
      this.initWaiter = null;
    };
    this.worker = w;
    w.postMessage({ type: "init", modelPath, onnxPath });
  }

  /** Download + warm the model. Rejects with "cancelled" if cancelled. */
  enable(modelPath: string, onnxPath: string): Promise<void> {
    this.gen++;
    this.worker?.terminate();
    for (const [, p] of this.pending) p.rej(new Error("cancelled"));
    this.pending.clear();
    this.progFiles.clear();
    this.set({ status: "downloading", bytesLoaded: 0, bytesTotal: 0, error: undefined, cancelled: false });
    this.spawn(modelPath, onnxPath);
    return new Promise<void>((res, rej) => {
      this.initWaiter = { res, rej };
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.worker || !this.ready) throw new Error("model not ready");
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.worker!.postMessage({ type: "embed", id, texts });
    });
  }

  cancel() {
    this.gen++;
    this.worker?.terminate();
    this.worker = null;
    this.initWaiter?.rej(new Error("cancelled"));
    this.initWaiter = null;
    for (const [, p] of this.pending) p.rej(new Error("cancelled"));
    this.pending.clear();
    this.set({ status: "off", bytesLoaded: 0, bytesTotal: 0, cancelled: true });
  }
}
