#!/usr/bin/env bash
# Fetch the pinned runtime assets that are deliberately excluded from the
# source archive (no large binaries in the source zip or repo history):
#
#   1. mixedbread-ai/mxbai-embed-xsmall-v1 @ e6ac24e5d6efb8782b59de1647b3ececb4ece94e
#      (Apache-2.0, (c) mixedbread.ai)  ->  public/models/mxbai-embed-xsmall-v1/
#      ~24.4 MB q8 ONNX embedding model + tokenizer files
#
#   2. onnxruntime-web @ the version pinned in package-lock.json (MIT)
#      ->  public/ort/  (copied from node_modules; `npm ci` must run first)
#      WASM runtime files used by transformers.js on CPU.
#
# Every file is verified against a hard-coded sha256 after fetch/copy — the
# script fails loudly on any mismatch or download error. Re-running is a
# no-op when files already verify.
set -euo pipefail
cd "$(dirname "$0")/.."

REV="e6ac24e5d6efb8782b59de1647b3ececb4ece94e"
HF="https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/resolve/${REV}"

MODEL_FILES=(
  "config.json:55f755d351fd04b0fef37760e07e195eb47e15f7aed6fc42d9be3dde3d38bca4"
  "onnx/model_quantized.onnx:952f996d8cf46c311ee8654a750fa942b71c8b94aabe69d043dbb2bcaff5528e"
  "special_tokens_map.json:5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a"
  "tokenizer.json:da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"
  "tokenizer_config.json:bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79"
  "vocab.txt:07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"
)
ORT_FILES=(
  "ort-wasm-simd-threaded.asyncify.mjs:0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611"
  "ort-wasm-simd-threaded.asyncify.wasm:49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082"
  "ort-wasm-simd-threaded.mjs:c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f"
  "ort-wasm-simd-threaded.wasm:06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3"
)

sha() { sha256sum "$1" | cut -d' ' -f1; }

fetch() { # url dest expected-sha
  local url="$1" dest="$2" want="$3"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && [ "$(sha "$dest")" = "$want" ]; then
    echo "ok    $dest (already present)"
    return 0
  fi
  echo "fetch $dest"
  curl -fSL --retry 3 --retry-delay 2 -o "$dest" "$url"
  [ "$(sha "$dest")" = "$want" ] || { echo "HASH MISMATCH: $dest"; sha256sum "$dest"; return 1; }
}

copy() { # src dest expected-sha
  local src="$1" dest="$2" want="$3"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && [ "$(sha "$dest")" = "$want" ]; then
    echo "ok    $dest (already present)"
    return 0
  fi
  echo "copy  $dest"
  cp "$src" "$dest"
  [ "$(sha "$dest")" = "$want" ] || { echo "HASH MISMATCH: $dest"; sha256sum "$dest"; return 1; }
}

echo "== model files (mxbai-embed-xsmall-v1 @ ${REV:0:7}, Apache-2.0) =="
for entry in "${MODEL_FILES[@]}"; do
  path="${entry%%:*}"; want="${entry##*:}"
  fetch "$HF/$path" "public/models/mxbai-embed-xsmall-v1/$path" "$want"
done

echo "== onnxruntime-web (MIT, from package-lock pinned node_modules) =="
ORTDIST="node_modules/onnxruntime-web/dist"
[ -d "$ORTDIST" ] || { echo "missing $ORTDIST — run 'npm ci' first"; exit 1; }
for entry in "${ORT_FILES[@]}"; do
  path="${entry%%:*}"; want="${entry##*:}"
  copy "$ORTDIST/$path" "public/ort/$path" "$want"
done

echo "all assets verified."
