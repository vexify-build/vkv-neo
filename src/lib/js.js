'use strict'

/**
 * Pure-JS engine — a Map under the hood, canonical-encoded keys so that
 * binary buffers and strings share one namespace. Powered By Vexify.
 */

const { toBytes, toCanonical, fromCanonical } = require('./bytes')

class JsEngine {
  constructor() {
    this.map = new Map()
  }

  get name() {
    return 'js'
  }

  set(key, value) {
    this.map.set(toCanonical(key), toCanonical(value))
    return this
  }

  get(key) {
    const v = this.map.get(toCanonical(key))
    return v === undefined ? undefined : fromCanonical(v)
  }

  has(key) {
    return this.map.has(toCanonical(key))
  }

  del(key) {
    return this.map.delete(toCanonical(key))
  }

  get size() {
    return this.map.size
  }

  clear() {
    this.map.clear()
  }

  putManyBytes(buf, count) {
    let off = 0
    let n = 0
    const limit = count === undefined || count === null ? Infinity : count
    while (off + 4 <= buf.length && n < limit) {
      const kl = buf.readUInt32LE(off)
      off += 4
      if (off + kl + 4 > buf.length) break
      const k = fromCanonical(buf.toString('utf8', off, off + kl))
      off += kl
      const vl = buf.readUInt32LE(off)
      off += 4
      if (off + vl > buf.length) break
      const v = fromCanonical(buf.toString('utf8', off, off + vl))
      off += vl
      this.map.set(k, v)
      n++
    }
    return n
  }

  getManyBytes(buf) {
    const keys = []
    let off = 0
    while (off + 4 <= buf.length) {
      const kl = buf.readUInt32LE(off)
      off += 4
      if (off + kl > buf.length) break
      keys.push(this.map.get(fromCanonical(buf.toString('utf8', off, off + kl))))
      off += kl
    }
    const out = Buffer.alloc(4)
    out.writeUInt32LE(keys.length, 0)
    const parts = [out]
    for (const v of keys) {
      if (v === undefined) {
        parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]))
      } else {
        const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')
        const head = Buffer.alloc(4)
        head.writeUInt32LE(b.length, 0)
        parts.push(head, b)
      }
    }
    return Buffer.concat(parts)
  }

  entries() {
    const parts = []
    const head = Buffer.alloc(4)
    head.writeUInt32LE(this.map.size, 0)
    parts.push(head)
    for (const [k, v] of this.map) {
      const kb = toBytes(fromCanonical(k))
      const vb = toBytes(fromCanonical(v))
      const e = Buffer.alloc(4 + kb.length + 4 + vb.length)
      e.writeUInt32LE(kb.length, 0)
      kb.copy(e, 4)
      e.writeUInt32LE(vb.length, 4 + kb.length)
      vb.copy(e, 8 + kb.length)
      parts.push(e)
    }
    return Buffer.concat(parts)
  }
}

module.exports = { JsEngine }