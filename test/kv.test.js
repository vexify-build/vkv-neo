'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const vkv = require('../src/index')
const { encodeEntries, parseGetMany } = require('../src/lib/bytes')

const MODES = ['js', 'wasm', 'rust'].filter((m) => m === 'js' || vkv.available()[m])

for (const mode of MODES) {
  test(`[${mode}] basic set/get/has/del`, () => {
    const kv = vkv.createKV({ mode })
    kv.clear()
    assert.strictEqual(kv.engine, mode === 'native' ? 'rust' : mode)
    assert.strictEqual(kv.get('nope'), undefined)
    kv.set('foo', 'bar')
    assert.strictEqual(kv.get('foo'), 'bar')
    assert.strictEqual(kv.has('foo'), true)
    assert.strictEqual(kv.has('nope'), false)
    assert.strictEqual(kv.del('foo'), true)
    assert.strictEqual(kv.del('foo'), false)
    assert.strictEqual(kv.get('foo'), undefined)
  })

  test(`[${mode}] number & boolean coercion`, () => {
    const kv = vkv.createKV({ mode })
    kv.clear()
    kv.set('n', 42)
    kv.set('b', true)
    assert.strictEqual(kv.get('n'), '42')
    assert.strictEqual(kv.get('b'), 'true')
  })

  test(`[${mode}] binary roundtrip`, () => {
    const kv = vkv.createKV({ mode })
    kv.clear()
    const key = Buffer.from([0x00, 0xff, 0xfe, 0x01])
    const val = Buffer.from([0xff, 0x00, 0xde, 0xad])
    kv.set(key, val)
    const out = kv.get(key)
    assert.ok(Buffer.isBuffer(out), 'binary value must come back as Buffer')
    assert.ok(out.equals(val))
    kv.set(key, 'plain')
    assert.strictEqual(kv.get(key), 'plain')
  })

  test(`[${mode}] putMany + getMany`, () => {
    const kv = vkv.createKV({ mode })
    kv.clear()
    const n = kv.putMany([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
    assert.strictEqual(n, 3)
    assert.strictEqual(kv.size, 3)
    assert.strictEqual(kv.get('b'), '2')
    const out = kv.getMany(['a', 'zzz', 'c'])
    assert.deepStrictEqual(out, ['1', undefined, '3'])
    const m = kv.putMany(new Map([['x', '9']]))
    assert.strictEqual(m, 1)
    assert.strictEqual(kv.get('x'), '9')
  })

  test(`[${mode}] bulk bytes layout roundtrip`, () => {
    const kv = vkv.createKV({ mode })
    kv.clear()
    const { buffer, count } = encodeEntries([
      ['k1', 'v1'],
      ['k2', 'v2'],
    ])
    assert.strictEqual(count, 2)
    assert.strictEqual(kv.putManyBytes(buffer), 2)
    const q = Buffer.alloc(4 + 2 + 4 + 2)
    q.writeUInt32LE(2, 0)
    q.write('k1', 4, 'latin1')
    q.writeUInt32LE(2, 6)
    q.write('k2', 10, 'latin1')
    const raw = kv.getManyBytes(q)
    const parsed = parseGetMany(raw)
    assert.deepStrictEqual(parsed, ['v1', 'v2'])
  })

  test(`[${mode}] clear + size`, () => {
    const kv = vkv.createKV({ mode })
    kv.clear()
    kv.putMany([['a', '1'], ['b', '2']])
    assert.strictEqual(kv.size, 2)
    kv.clear()
    assert.strictEqual(kv.size, 0)
    assert.strictEqual(kv.get('a'), undefined)
  })
}

test('mode resolution', () => {
  assert.throws(() => vkv.createKV({ mode: 'bogus' }), /unknown mode/)
  assert.strictEqual(vkv.createKV({ mode: 'js' }).engine, 'js')
  assert.ok(vkv.available().js === true)
})

test('checkMode auto picks first available', () => {
  const kv = vkv.createKV()
  assert.ok(['js', 'wasm', 'rust'].includes(kv.engine))
})

test('putMany rejects garbage', () => {
  const kv = vkv.createKV({ mode: 'js' })
  assert.throws(() => kv.putMany(42), /putMany/)
})