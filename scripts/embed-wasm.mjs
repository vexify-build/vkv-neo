import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [wasmPath, outPath] = process.argv.slice(2)
if (!wasmPath || !outPath) {
  console.error('usage: node embed-wasm.mjs <input.wasm> <output.js>')
  process.exit(1)
}

const bytes = readFileSync(wasmPath)
const js = `'use strict'

// GENERATED FILE — do not edit by hand. Regenerate with: npm run build:wasm
// vkv-neo WASM engine (embedded as base64, zero build-time loading).
// Powered By Vexify.
// prettier-ignore
const B64 = ${JSON.stringify(bytes.toString('base64'))}

let cached = null

function load() {
  if (!cached) {
    const buf = Buffer.from(B64, 'base64')
    const mod = new WebAssembly.Module(buf)
    const inst = new WebAssembly.Instance(mod)
    cached = inst.exports
    if (typeof cached.vkv_init === 'function') cached.vkv_init()
  }
  return cached
}

module.exports = { load, byteLength: ${bytes.length} }
`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, js)
console.log(`vkv-neo wasm embedded: ${bytes.length} bytes -> ${outPath}`)