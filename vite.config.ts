import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  plugins: [{
    name: "onnx-preview-mime",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        // Vite 5 does not recognize .onnx. Its preview compression otherwise
        // treats the empty MIME type as text, removing Content-Length and
        // triggering a redundant streaming metadata download in Transformers.
        if (req.url?.split("?")[0].endsWith(".onnx")) {
          res.setHeader("Content-Type", "application/octet-stream");
        }
        next();
      });
    },
  }],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2500,
  },
});
