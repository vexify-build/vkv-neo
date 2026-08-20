#!/usr/bin/env bash
# Build the vkv-neo WASM engine and embed it as base64 JS. Powered By Vexify.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --target wasm32-unknown-unknown --manifest-path wasm/Cargo.toml
node scripts/embed-wasm.mjs \
  target/wasm32-unknown-unknown/release/vkv_neo_wasm.wasm \
  src/wasm/vkv-neo-wasm.js