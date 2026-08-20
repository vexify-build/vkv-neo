'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vkv = require('../src/index')

const MODES = ['js', 'wasm', 'rust'].filter((m) => m === 'js' || vkv.available()[m])

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vkv-test-'))
}

for (const mode of MODES) {
  test(`[${mode}] storage: disk WAL roundtrip`, () => {
    const dir = tmpDir()
    const file = path.join(dir, 'db')
    const kv = vkv.createKV({ mode, storage: 'disk', file, sync: true })
    kv.clear()
    kv.set('a', '1')
    kv.putMany([['b', '2'], ['c', '3']])
    kv.del('a')
    kv.set('x', '9')
    kv.clear()
    kv.set('keep', 'me')
    kv.close()

    const reopened = vkv.createKV({ mode, storage: 'disk', file })
    assert.strictEqual(reopened.size, 1)
    assert.strictEqual(reopened.get('keep'), 'me')
    assert.strictEqual(reopened.get('x'), undefined)
    assert.strictEqual(reopened.get('a'), undefined)
    reopened.clear()
    reopened.close()
  })

  test(`[${mode}] storage: hybrid snapshot roundtrip`, () => {
    const dir = tmpDir()
    const file = path.join(dir, 'db')
    const kv = vkv.createKV({ mode, storage: 'hybrid', file })
    kv.clear()
    kv.set('h', 'i')
    kv.putMany([['j', 'k']])
    kv.flush()
    kv.close()

    const reopened = vkv.createKV({ mode, storage: 'hybrid', file })
    assert.strictEqual(reopened.size, 2)
    assert.strictEqual(reopened.get('h'), 'i')
    assert.strictEqual(reopened.get('j'), 'k')
    reopened.clear()
    reopened.close()
  })

  test(`[${mode}] storage: ram is default & non-persistent`, () => {
    const dir = tmpDir()
    const file = path.join(dir, 'db')
    const kv = vkv.createKV({ mode })
    assert.strictEqual(kv.storage, 'ram')
    kv.set('gone', 'soon')
    assert.strictEqual(kv.get('gone'), 'soon')
    const reopened = vkv.createKV({ mode, storage: 'hybrid', file })
    reopened.clear()
    assert.strictEqual(reopened.get('gone'), undefined)
    reopened.close()
  })

  test(`[${mode}] storage: binary values survive disk`, () => {
    const dir = tmpDir()
    const file = path.join(dir, 'db')
    const key = Buffer.from([0x00, 0xff, 0xfe])
    const val = Buffer.from([0xff, 0x00, 0xde])
    const kv = vkv.createKV({ mode, storage: 'disk', file })
    kv.clear()
    kv.set(key, val)
    kv.close()

    const reopened = vkv.createKV({ mode, storage: 'disk', file })
    const out = reopened.get(key)
    assert.ok(Buffer.isBuffer(out))
    assert.ok(out.equals(val))
    reopened.clear()
    reopened.close()
  })
}

test('storage: unknown storage rejects', () => {
  assert.throws(() => vkv.createKV({ storage: 'ssd' }), /unknown storage/)
})