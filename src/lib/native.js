'use strict'

/**
 * Native (.node) engine loader — vkv-neo compiled with Rust, exposed through
 * N-API (Node-API). Per-platform binary under native/<platform>-<arch>/.
 * Powered By Vexify.
 */

const path = require('path')
const fs = require('fs')

function resolveNativePath() {
  if (process.env.VKV_NATIVE_PATH) {
    const p = path.resolve(process.env.VKV_NATIVE_PATH)
    if (fs.existsSync(p)) return p
  }
  const platform = `${process.platform}-${process.arch}`
  const candidates = [
    path.join(__dirname, '..', 'native', platform, 'vkv-neo.node'),
    path.join(__dirname, '..', '..', 'native', platform, 'vkv-neo.node'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

let nativePath = null
let nativeModule = null
let tried = false

function loadNative() {
  if (tried) return nativeModule
  tried = true
  nativePath = resolveNativePath()
  if (nativePath) {
    try {
      nativeModule = require(nativePath)
    } catch (err) {
      nativeModule = null
      if (process.env.VKV_NATIVE_FORCE) throw err
    }
  }
  return nativeModule
}

class NativeEngine {
  constructor() {
    if (!loadNative()) {
      throw new Error('vkv: native (.node) engine unavailable — run `npm run build:native` or use mode "wasm"/"js"')
    }
  }

  get name() {
    return 'rust'
  }

  get raw() {
    return loadNative()
  }

  set(key, value) {
    loadNative().set(key, value)
    return this
  }

  get(key) {
    return loadNative().get(key)
  }

  has(key) {
    return loadNative().has(key)
  }

  del(key) {
    return loadNative().del(key)
  }

  get size() {
    return loadNative().len()
  }

  clear() {
    loadNative().clear()
  }

  putManyBytes(buf, count) {
    const n = loadNative().putMany(buf, count === undefined ? buf.length : count)
    return n
  }

  getManyBytes(buf) {
    return loadNative().getMany(buf)
  }

  entries() {
    return loadNative().entries()
  }

  version() {
    return loadNative().version()
  }
}

module.exports = { NativeEngine, isNativeAvailable: () => loadNative() !== null, nativePath }