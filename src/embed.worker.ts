/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export interface WorkerIn {
  type: "init" | "embed";
  id?: number;
  modelPath?: string;
  onnxPath?: string;
  texts?: string[];
  maxBatch?: number;
}

export interface WorkerOut {
  type: "progress" | "ready" | "embedded" | "error";
  id?: number;
  loaded?: number;
  total?: number;
  file?: string;
  loadMs?: number;
  embeddings?: Float32Array[];
  message?: string;
}

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<void> | null = null;

async function init(modelPath: string, onnxPath: string) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelPath.endsWith("/") ? modelPath : modelPath + "/";
  // transformers.js browser cache keeps the model available on reloads.
  // Serve ONNX Runtime WASM from the same static host (no CDN call).
  const base = onnxPath.endsWith("/") ? onnxPath : onnxPath + "/";
  env.backends.onnx.wasm!.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  const t0 = performance.now();
  extractor = (await pipeline("feature-extraction", "mxbai-embed-xsmall-v1", {
    dtype: "q8",
    // revision pinned at build time; model files are vendored under ./models/
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.loaded != null) {
        post({ type: "progress", file: p.file ?? "", loaded: p.loaded, total: p.total ?? 0 });
      }
    },
  })) as FeatureExtractionPipeline;
  post({ type: "ready", loadMs: Math.round(performance.now() - t0) });
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      initPromise ??= init(m.modelPath!, m.onnxPath!);
      await initPromise;
      return;
    }
    if (m.type === "embed") {
      if (initPromise) await initPromise;
      if (!extractor) throw new Error("model not initialized");
      const texts = m.texts ?? [];
      // mxbai-embed-xsmall-v1: symmetric encoding (no query prefix per model card),
      // mean pooling + L2 normalize → cosine-ready vectors
      const r = await extractor(texts, { pooling: "mean", normalize: true });
      const out: Float32Array[] = (r.tolist() as number[][]).map((v) => new Float32Array(v));
      post({ type: "embedded", id: m.id, embeddings: out }, out.map((e) => e.buffer));
    }
  } catch (err) {
    post({ type: "error", id: m.id, message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
};
