'use strict'

/**
 * vkv-neo — 超高速多引擎 Key-Value Store。
 * UF3 engines: JS / WASM / Rust (N-API .node). Powered By Vexify.
 *
 *   const vkv = require('vkv-neo')
 *   const kv = vkv.createKV({ mode: 'auto' })   // 'js' | 'wasm' | 'rust'
 *   kv.set('foo', 'bar'); kv.get('foo'); kv.del('foo')
 */

const { JsEngine } = require('./lib/js')
const { WasmEngine } = require('./lib/wasm')
const { NativeEngine, isNativeAvailable } = require('./lib/native')
const { Storage } = require('./lib/storage')
const { toBytes, decodeBytes, encodeEntries, parseGetMany } = require('./lib/bytes')

const ENGINE_NAMES = ['js', 'wasm', 'rust', 'native']

function available() {
  return {
    js: true,
    wasm: typeof WebAssembly !== 'undefined',
    rust: isNativeAvailable(),
  }
}

function checkMode(mode) {
  const m = String(mode || 'auto').toLowerCase()
  if (m === 'native') return 'rust'
  if (m === 'rust' || m === 'wasm' || m === 'js') return m
  if (m === 'auto') return null
  throw new Error(`vkv: unknown mode "${mode}" — expected "js", "wasm", "rust" or "auto"`)
}

function resolveMode(mode) {
  const requested = checkMode(mode)
  if (requested) {
    if (requested === 'rust' && !isNativeAvailable()) {
      throw new Error('vkv: mode "rust" unavailable — .node binary not found; choose "wasm" or "js", or run `npm run build:native`')
    }
    if (requested === 'wasm' && typeof WebAssembly === 'undefined') {
      throw new Error('vkv: mode "wasm" unavailable in this runtime')
    }
    return requested
  }
  // auto: rust > wasm > js
  if (isNativeAvailable()) return 'rust'
  if (typeof WebAssembly !== 'undefined') return 'wasm'
  return 'js'
}

class Kv {
  constructor(engine, mode, storageOpts) {
    this._engine = engine
    this._mode = mode
    this._storage = null
    if (storageOpts && storageOpts.storage && storageOpts.storage !== 'ram') {
      this._storage = new Storage(engine, storageOpts)
    }
    this._backend = this._storage || engine
  }

  /**
   * Create a KV store.
   *   createKV()                 // auto: rust > wasm > js, in-memory
   *   createKV({ mode: 'js' | 'wasm' | 'rust' | 'auto' })
   *   createKV({ storage: 'ram' | 'disk' | 'hybrid', file: './my-db' })
   *   createKV({ storage: 'disk', file: './my-db', sync: true })
   *   createKV({ storage: 'hybrid', file: './my-db', flushIntervalMs: 2000 })
   *
   * 引擎 engine: js | wasm | rust
   * 存储 storage: ram 纯内存 / disk 日志落盘 / hybrid 快照落盘
   */
  get mode() {
    return this._mode
  }

  /** engine name: 'js' | 'wasm' | 'rust' */
  get engine() {
    return this._mode
  }

  /** storage name: 'ram' | 'disk' | 'hybrid' */
  get storage() {
    return this._storage ? this._storage.storage : 'ram'
  }

  get size() {
    return this._backend.size
  }

  set(key, value) {
    this._backend.set(normalize(key), normalize(value))
    return this
  }

  get(key) {
    const v = this._backend.get(normalize(key))
    return decodeBytes(v)
  }

  has(key) {
    return this._backend.has(normalize(key))
  }

  del(key) {
    return this._backend.del(normalize(key))
  }

  clear() {
    this._backend.clear()
    return this
  }

  /**
   * Bulk insert. Accepts:
   *   putMany([['k1','v1'],['k2','v2']])
   *   putMany(new Map([...]))
   *   putMany({ k1: 'v1', k2: 'v2' })
   *   putMany(rawBuffer)                   — already-encoded bulk layout
   * Returns the number of entries written.
   */
  putMany(entries) {
    if (Buffer.isBuffer(entries) || entries instanceof Uint8Array) {
      return this.putManyBytes(entries)
    }
    const { buffer, count } = encodeEntries(entries)
    return this.putManyBytes(buffer, count)
  }

  putManyBytes(buf, count) {
    return this._backend.putManyBytes(Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), count)
  }

  /**
   * Bulk get. Keys: array/Set/iterable of keys, or an encoded bulk-get buffer.
   * Returns an Array of values aligned with the input keys (undefined = miss)
   * — or, for a raw buffer input, the raw result Buffer.
   */
  getMany(keys) {
    if (Buffer.isBuffer(keys) || keys instanceof Uint8Array) {
      return this.getManyBytes(keys)
    }
    const list = Array.from(keys)
    const parts = []
    for (const k of list) {
      const kb = toBytes(k)
      const head = Buffer.alloc(4 + kb.length)
      head.writeUInt32LE(kb.length, 0)
      kb.copy(head, 4)
      parts.push(head)
    }
    const qbuf = Buffer.concat(parts)
    return parseGetMany(this.getManyBytes(qbuf))
  }

  getManyBytes(buf) {
    return this._backend.getManyBytes(Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
  }

  /** All entries as a bulk buffer (snapshot layout). */
  entries() {
    return this._backend.entries()
  }

  /** Flush pending data to disk (disk/hybrid). */
  flush() {
    if (this._storage) this._storage.flushSync()
    return this
  }

  /** Flush and release resources. */
  close() {
    if (this._storage) this._storage.close()
  }

  version() {
    return 1
  }
}

/**
 * Normalize user-facing key/value so engines only see string | Buffer | Uint8Array.
 */
function normalize(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string' || Buffer.isBuffer(v) || v instanceof Uint8Array) return v
  throw new TypeError('vkv: key/value must be string, Buffer, Uint8Array, number or boolean')
}

/**
 * Create a KV store.
 *   createKV()                 // auto: rust > wasm > js
 *   createKV({ mode: 'auto' })
 *   createKV({ mode: 'js' | 'wasm' | 'rust' })
 */
function createKV(opts) {
  const o = opts || {}
  const mode = resolveMode(o.mode || 'auto')
  let engine
  if (mode === 'rust') engine = new NativeEngine()
  else if (mode === 'wasm') engine = new WasmEngine()
  else engine = new JsEngine()
  const storage = (o.storage || 'ram').toLowerCase()
  if (!['ram', 'disk', 'hybrid'].includes(storage)) {
    throw new Error(`vkv: unknown storage "${o.storage}" — expected "ram", "disk" or "hybrid"`)
  }
  const storageOpts =
    storage === 'ram'
      ? null
      : { storage, file: o.file, sync: o.sync, flushIntervalMs: o.flushIntervalMs }
  return new Kv(engine, mode, storageOpts)
}

module.exports = {
  createKV,
  available,
  ENGINE_NAMES,
  version: '1.0.0',
  poweredBy: 'Vexify',
}