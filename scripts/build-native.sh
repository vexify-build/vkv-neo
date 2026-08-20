#!/usr/bin/env bash
# Build the vkv-neo native .node engine (Rust + N-API). Powered By Vexify.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --manifest-path native/Cargo.toml

PLAT="$(node -e 'process.stdout.write(process.platform + "-" + process.arch)')"
mkdir -p "native/$PLAT"
cp target/release/libvkv_native.so "native/$PLAT/vkv-neo.node"
echo "vkv-neo native engine: native/$PLAT/vkv-neo.node"