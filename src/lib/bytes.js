'use strict'

/**
 * Byte <-> string canonical helpers shared by all backends.
 * Rules:
 *   - string            -> stored as UTF-8 bytes (native/wasm) or as-is (js)
 *   - Buffer/Uint8Array -> stored as raw bytes
 *   - number/boolean    -> coerced to String, then as string
 * Decoding is lossless: valid-UTF-8 bytes come back as string,
 * arbitrary bytes come back as Buffer. Powered By Vexify.
 */

const PREFIX = '\u0000' // latin1 escape prefix, unreserved by UTF-8 strings

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (typeof value === 'number' || typeof value === 'boolean') return Buffer.from(String(value), 'utf8')
  throw new TypeError('vkv: key/value must be string, Buffer, Uint8Array, number or boolean')
}

function toCanonical(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    const s = b.toString('utf8')
    return b.equals(Buffer.from(s, 'utf8')) ? s : PREFIX + b.toString('latin1')
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new TypeError('vkv: key/value must be string, Buffer, Uint8Array, number or boolean')
}

function fromCanonical(s) {
  if (typeof s === 'string') {
    if (s.length > 0 && s.charCodeAt(0) === 0) return Buffer.from(s.slice(1), 'latin1')
    return s
  }
  return s
}

function decodeBytes(b) {
  if (!Buffer.isBuffer(b)) return b
  const s = b.toString('utf8')
  return b.equals(Buffer.from(s, 'utf8')) ? s : b
}

/**
 * Encode entries into the bulk buffer layout:
 * `[u32 key_len][key][u32 val_len][val] ...' (little-endian)
 * entries: Map | object | array of [k, v] | iterable of [k, v]
 */
function encodeEntries(entries, out) {
  let buf = out || null
  let off = 0
  let n = 0
  const write = (v) => {
    const b = toBytes(v)
    if (!buf || off + b.length + 8 > buf.length) {
      const grow = Math.max(buf ? buf.length * 2 : 1024, off + b.length + 8)
      const next = Buffer.alloc(grow)
      if (buf) buf.copy(next, 0, 0, off)
      buf = next
    }
    buf.writeUInt32LE(b.length, off)
    off += 4
    b.copy(buf, off)
    off += b.length
    return b
  }
  if (Buffer.isBuffer(entries) || entries instanceof Uint8Array) {
    return { buffer: Buffer.isBuffer(entries) ? entries : Buffer.from(entries.buffer, entries.byteOffset, entries.byteLength), count: null }
  }
  if (entries instanceof Map) {
    for (const [k, v] of entries) {
      const kb = write(k)
      const vb = write(v)
      n++
      void kb; void vb
    }
  } else if (Array.isArray(entries)) {
    for (const [k, v] of entries) {
      write(k)
      write(v)
      n++
    }
  } else if (entries && typeof entries === 'object') {
    for (const k of Object.keys(entries)) {
      write(k)
      write(entries[k])
      n++
    }
  } else if (entries && typeof entries[Symbol.iterator] === 'function') {
    for (const [k, v] of entries) {
      write(k)
      write(v)
      n++
    }
  } else {
    throw new TypeError('vkv: putMany() expects a Map, object, or iterable of [key, value]')
  }
  return { buffer: buf.subarray(0, off), count: n }
}

/**
 * Parse a bulk-get result Buffer:
 * `[u32 count][u32 val_len | 0xFFFFFFFF][val] ...'
 * Returns an Array aligned with the queried keys.
 */
function parseGetMany(buf) {
  const count = buf.readUInt32LE(0)
  const out = new Array(count)
  let off = 4
  for (let i = 0; i < count; i++) {
    const vlen = buf.readUInt32LE(off)
    off += 4
    if (vlen === 0xffffffff) {
      out[i] = undefined
    } else {
      out[i] = decodeBytes(buf.subarray(off, off + vlen))
      off += vlen
    }
  }
  return out
}

module.exports = { toBytes, toCanonical, fromCanonical, decodeBytes, encodeEntries, parseGetMany }