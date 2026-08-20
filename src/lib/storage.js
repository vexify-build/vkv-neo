'use strict'

/**
 * Storage backends for vkv-neo — RAM / Disk / Hybrid. Powered By Vexify.
 *
 *   ram    纯内存 · in-memory only (default; fastest)
 *   disk   Write-Ahead Log 追加落盘 + fsync 可选 · durable WAL
 *   hybrid 内存读写 + 定期快照 / 退出 flush · snapshot-based autosave
 *
 * File formats (little-endian):
 *   .wal : 'VKVNWAL1' + ops: [u8 op][u32 klen][key][u32 vlen][val]
 *          op: 0x01 PUT, 0x02 DEL(tombstone), 0x03 CLEAR
 *   .snap: 'VKVNSNAP' + [u32 count][u32 klen][key][u32 vlen][val] ...
 */

const fs = require('fs')
const path = require('path')

const WAL_MAGIC = Buffer.from('VKVNWAL1')
const SNAP_MAGIC = Buffer.from('VKVNSNAP')
const OP_PUT = 0x01
const OP_DEL = 0x02
const OP_CLEAR = 0x03

const storages = new Set()
let hooksRegistered = false

/** Register storage for process-exit flush (once globally). */
function registerExitHook(storage) {
  storages.add(storage)
  if (hooksRegistered || typeof process === 'undefined' || !process.on) return
  hooksRegistered = true
  const flushAll = () => {
    for (const s of storages) {
      try {
        s.flushSync()
      } catch {}
    }
  }
  process.on('beforeExit', flushAll)
  process.on('exit', flushAll)
}

/**
 * Encode `[u32 klen][key][u32 vlen][val]` entry bytes (shared layout).
 */
function entryBytes(key, value) {
  const k = toBytes(key)
  const v = toBytes(value)
  const out = Buffer.alloc(4 + k.length + 4 + v.length)
  out.writeUInt32LE(k.length, 0)
  k.copy(out, 4)
  out.writeUInt32LE(v.length, 4 + k.length)
  v.copy(out, 8 + k.length)
  return out
}

/**
 * Replay entries from a snapshot buffer into the engine.
 * `buf` starts with [magic 8][u32 count][entries...]
 */
function loadEntriesInto(engine, buf) {
  if (buf.subarray(0, 8).equals(SNAP_MAGIC) === false) return 0
  if (buf.length < 12) return 0
  const count = buf.readUInt32LE(8)
  let off = 12
  for (let i = 0; i < count; i++) {
    if (off + 4 > buf.length) break
    const kl = buf.readUInt32LE(off)
    off += 4
    if (off + kl + 4 > buf.length) break
    const key = buf.subarray(off, off + kl)
    off += kl
    const vl = buf.readUInt32LE(off)
    off += 4
    if (off + vl > buf.length) break
    const val = buf.subarray(off, off + vl)
    off += vl
    engine.set(key, val)
  }
  return off
}

/**
 * Wraps an engine with a persistence policy.
 */
class Storage {
  /**
   * @param {object} engine  KV engine
   * @param {object} opts    { storage: 'ram'|'disk'|'hybrid', file, sync, flushIntervalMs }
   */
  constructor(engine, opts) {
    this.engine = engine
    this.storage = opts.storage || 'ram'
    this.base = path.resolve(opts.file || 'vkv-neo.data')
    this.sync = opts.sync !== false
    this.flushIntervalMs = opts.flushIntervalMs || 1000
    this.walPath = this.base + '.wal'
    this.snapPath = this.base + '.snap'

    this._fd = -1
    this._walBuffer = []
    this._walBytes = 0
    this._dirty = false
    this._timer = null

    if (this.storage === 'disk') {
      this._openWal()
      this._replay()
    } else if (this.storage === 'hybrid') {
      this._loadSnapshot()
    }

    if (this.storage === 'hybrid') {
      if (typeof setInterval === 'function') {
        this._timer = setInterval(() => this.flush(), this.flushIntervalMs)
        if (this._timer.unref) this._timer.unref()
      }
    }

    registerExitHook(this)
  }

  // ------------------------------------------------------------------ disk

  _openWal() {
    fs.mkdirSync(path.dirname(this.base), { recursive: true })
    this._fd = fs.openSync(this.walPath, 'a')
    if (fs.statSync(this.walPath).size === 0) {
      fs.writeSync(this._fd, WAL_MAGIC)
    }
  }

  _replay() {
    if (!fs.existsSync(this.walPath)) return
    const file = fs.readFileSync(this.walPath)
    let off = 0
    if (file.subarray(0, 8).equals(WAL_MAGIC)) off = 8
    while (off + 5 <= file.length) {
      const op = file[off]
      off += 1
      if (op === OP_CLEAR) {
        this.engine.clear()
        continue
      }
      if (off + 4 > file.length) break
      const kl = file.readUInt32LE(off)
      off += 4
      if (off + kl + 4 > file.length) break
      const key = file.subarray(off, off + kl)
      off += kl
      if (op === OP_DEL) {
        this.engine.del(key)
        continue
      }
      const vl = file.readUInt32LE(off)
      off += 4
      if (off + vl > file.length) break
      const val = file.subarray(off, off + vl)
      off += vl
      this.engine.set(key, val)
    }
    // compact after replay: rewrite WAL from current memory state
    this.compact()
  }

  _walPut(keysBytes) {
    if (this._walBytes + keysBytes.length > 1 << 20) this._flushWal()
    this._walBuffer.push(keysBytes)
    this._walBytes += keysBytes.length
    this._flushWal()
  }

  _flushWal() {
    if (!this._walBuffer.length) return
    const buf = Buffer.concat(this._walBuffer)
    this._walBuffer = []
    this._walBytes = 0
    if (this._fd >= 0) {
      let written = 0
      while (written < buf.length) {
        written += fs.writeSync(this._fd, buf, written, buf.length - written)
      }
    }
    if (this.sync) {
      this._fsync()
    }
  }

  _fsync() {
    if (this._fd >= 0) {
      try {
        fs.fsyncSync(this._fd)
      } catch {}
    }
  }

  /** Rewrite WAL from current in-memory state as a PUT op stream (compaction). */
  compact() {
    if (this._fd >= 0) {
      try {
        fs.closeSync(this._fd)
      } catch {}
      this._fd = -1
    }
    fs.writeFileSync(this.walPath, this._entriesToWal())
    this._fd = fs.openSync(this.walPath, 'a')
    this._walBuffer = []
    this._walBytes = 0
    this._fsync()
  }

  /** Encode engine snapshot entries as a WAL op stream (with magic). */
  _entriesToWal() {
    const data = this.engine.entries()
    const ops = []
    let off = 4
    const count = data.readUInt32LE(0)
    for (let i = 0; i < count; i++) {
      const kl = data.readUInt32LE(off)
      off += 4
      const key = data.subarray(off, off + kl)
      off += kl
      const vl = data.readUInt32LE(off)
      off += 4
      const val = data.subarray(off, off + vl)
      off += vl
      const e = Buffer.alloc(5 + kl + 4 + vl)
      e[0] = OP_PUT
      e.writeUInt32LE(kl, 1)
      key.copy(e, 5)
      e.writeUInt32LE(vl, 5 + kl)
      val.copy(e, 9 + kl)
      ops.push(e)
    }
    return Buffer.concat([WAL_MAGIC, ...ops])
  }

  // ---------------------------------------------------------------- hybrid

  _loadSnapshot() {
    if (!fs.existsSync(this.snapPath)) return
    const file = fs.readFileSync(this.snapPath)
    loadEntriesInto(this.engine, file)
  }

  // --------------------------------------------------------------- public

  /** Sync flush (hybrid → snapshot, disk → wal sync). */
  flush() {
    if (this.storage === 'hybrid') this._writeSnapshot()
    if (this.storage === 'disk') this._flushWal()
  }

  flushSync() {
    this.flush()
  }

  _writeSnapshot() {
    const data = this.engine.entries()
    const buf = Buffer.alloc(SNAP_MAGIC.length + data.length)
    SNAP_MAGIC.copy(buf, 0)
    data.copy(buf, SNAP_MAGIC.length)
    fs.mkdirSync(path.dirname(this.base), { recursive: true })
    const tmp = this.snapPath + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, this.snapPath)
    if (this.sync) {
      const fd = fs.openSync(this.snapPath, 'r')
      try { fs.fsyncSync(fd) } catch {}
      fs.closeSync(fd)
    }
    this._dirty = false
  }

  close() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this.flushSync()
    if (this._fd >= 0) {
      try { fs.closeSync(this._fd) } catch {}
      this._fd = -1
    }
  }

  // ---------------------------------------------------------- engine API

  get engineName() {
    return this.engine.name
  }

  set(key, value) {
    this.engine.set(key, value)
    if (this.storage === 'disk') {
      this._walPut(Buffer.concat([Buffer.from([OP_PUT]), entryBytes(key, value)]))
    } else if (this.storage === 'hybrid') {
      this._dirty = true
    }
    return this
  }

  get(key) {
    return this.engine.get(key)
  }

  has(key) {
    return this.engine.has(key)
  }

  del(key) {
    const ok = this.engine.del(key)
    if (ok) {
      if (this.storage === 'disk') {
        const k = toBytes(key)
        const e = Buffer.alloc(5 + k.length)
        e[0] = OP_DEL
        e.writeUInt32LE(k.length, 1)
        k.copy(e, 5)
        this._walPut(e)
      } else if (this.storage === 'hybrid') {
        this._dirty = true
      }
    }
    return ok
  }

  get size() {
    return this.engine.size
  }

  clear() {
    this.engine.clear()
    if (this.storage === 'disk') {
      this._walPut(Buffer.from([OP_CLEAR]))
      this.compact()
    } else if (this.storage === 'hybrid') {
      this._dirty = true
    }
  }

  putManyBytes(buf, count) {
    const n = this.engine.putManyBytes(buf, count)
    if (this.storage === 'disk' && n > 0) {
      // wrap provided bulk bytes as one PUT op per entry
      const ops = []
      let off = 0
      for (let i = 0; i < n; i++) {
        const kl = buf.readUInt32LE(off)
        off += 4
        const key = buf.subarray(off, off + kl)
        off += kl
        const vl = buf.readUInt32LE(off)
        off += 4
        const val = buf.subarray(off, off + vl)
        off += vl
        const e = Buffer.alloc(5 + kl + 4 + vl)
        e[0] = OP_PUT
        e.writeUInt32LE(kl, 1)
        key.copy(e, 5)
        e.writeUInt32LE(vl, 5 + kl)
        val.copy(e, 9 + kl)
        ops.push(e)
      }
      this._walPut(Buffer.concat(ops))
    } else if (this.storage === 'hybrid' && n > 0) {
      this._dirty = true
    }
    return n
  }

  getManyBytes(buf) {
    return this.engine.getManyBytes(buf)
  }

  entries() {
    return this.engine.entries()
  }
}

// handle opts.file containing a custom path
function toBytes(v) {
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  return Buffer.from(String(v), 'utf8')
}

module.exports = { Storage, entryBytes, loadEntriesInto }