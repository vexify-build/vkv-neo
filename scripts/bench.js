'use strict'

/**
 * vkv-neo benchmark — 基准测试.
 * Usage: node scripts/bench.js [--mode js|wasm|rust] [--count 1000000] [--batch 100000] [--json]
 * Powered By Vexify.
 */

const vkv = require('../src/index')
const { encodeEntries } = require('../src/lib/bytes')

function parseArgs() {
  const argv = process.argv.slice(2)
  const out = { mode: 'all', count: 1000000, batch: 100000, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode' || a === '-m') out.mode = argv[++i]
    else if (a === '--count' || a === '-n') out.count = Number(argv[++i])
    else if (a === '--batch' || a === '-b') out.batch = Number(argv[++i])
    else if (a === '--json') out.json = true
  }
  return out
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

function fmtOps(ops) {
  return fmt(Math.round(ops))
}

async function benchMode(mode, count, batch) {
  const kv = vkv.createKV({ mode })
  const K = 12 // "key-01234567"
  const V = 12 // "val-01234567"

  // build the whole bulk buffer once (untimed): [u32 klen][key][u32 vlen][val]...
  const buf = Buffer.alloc(count * (8 + K + V))
  let off = 0
  for (let i = 0; i < count; i++) {
    const k = Buffer.from('key-' + String(i).padStart(8, '0'), 'utf8')
    const v = Buffer.from('val-' + String(i).padStart(8, '0'), 'utf8')
    buf.writeUInt32LE(k.length, off); off += 4
    k.copy(buf, off); off += k.length
    buf.writeUInt32LE(v.length, off); off += 4
    v.copy(buf, off); off += v.length
  }

  // query buffer
  const qbuf = Buffer.alloc(count * (4 + K))
  off = 0
  for (let i = 0; i < count; i++) {
    const k = Buffer.from('key-' + String(i).padStart(8, '0'), 'utf8')
    qbuf.writeUInt32LE(k.length, off); off += 4
    k.copy(qbuf, off); off += k.length
  }

  const batches = Math.ceil(count / batch)

  // warmup 2 batches
  for (let i = 0; i < Math.min(2, batches); i++) {
    const s = i * batch
    const sub = buf.subarray(s * (8 + K + V), (s + batch) * (8 + K + V))
    kv.putManyBytes(sub)
  }
  kv.clear()

  // ---- bulk put ----
  let t = process.hrtime.bigint()
  for (let i = 0; i < batches; i++) {
    const s = i * batch
    const sub = buf.subarray(s * (8 + K + V), (s + batch) * (8 + K + V))
    kv.putManyBytes(sub)
  }
  let ms = Number(process.hrtime.bigint() - t) / 1e6
  const putOps = count / (ms / 1000)
  const putExpected = count === kv.size

  // ---- bulk get ----
  t = process.hrtime.bigint()
  for (let i = 0; i < batches; i++) {
    const s = i * batch
    const sub = qbuf.subarray(s * (4 + K), (s + batch) * (4 + K))
    kv.getManyBytes(sub)
  }
  ms = Number(process.hrtime.bigint() - t) / 1e6
  const getOps = count / (ms / 1000)

  // ---- single set (native API path) ----
  kv.clear()
  t = process.hrtime.bigint()
  for (let i = 0; i < Math.min(count, 200e3); i++) {
    kv.set('key-' + String(i).padStart(8, '0'), 'val-' + String(i).padStart(8, '0'))
  }
  const nSingle = Math.min(count, 200e3)
  ms = Number(process.hrtime.bigint() - t) / 1e6
  const singleOps = nSingle / (ms / 1000)

  return {
    mode,
    singleSet: singleOps,
    bulkPut: putOps,
    bulkGet: getOps,
    putVerified: putExpected,
  }
}

async function main(optsIn) {
  const { mode, count, batch, json } = optsIn || parseArgs()
  const modes = mode === 'all' ? ['js', 'wasm', 'rust'].filter((m) => m === 'js' || vkv.available()[m]) : [mode]
  const results = []
  for (const m of modes) {
    results.push(await benchMode(m, count, batch))
  }

  if (json) {
    console.log(JSON.stringify({ count, batch, results }, null, 2))
    return
  }

  const line = '='.repeat(66)
  console.log(line)
  console.log(' vkv-neo benchmark — 基准测试   Powered By Vexify')
  console.log(` entries: ${count.toLocaleString()}  batch: ${batch.toLocaleString()}`)
  console.log(line)
  console.log(' ┌────────┬──────────────┬──────────────┬──────────────┬────────┐')
  console.log(' │ engine │  single set  │   bulk put   │   bulk get   │ verify │')
  console.log(' ├────────┼──────────────┼──────────────┼──────────────┼────────┤')
  for (const r of results) {
    const ok = r.putVerified ? '✓ ' : '✗ '
    console.log(
      ` │ ${r.mode.padEnd(6)} │ ${fmtOps(r.singleSet).padStart(11)}/s │ ${fmtOps(r.bulkPut).padStart(11)}/s │ ${fmtOps(r.bulkGet).padStart(11)}/s │ ${ok}  │`
    )
  }
  console.log(' └────────┴──────────────┴──────────────┴──────────────┴────────┘')
  const best = results.map((r) => r.bulkPut).sort((a, b) => b - a)[0]
  console.log(` peak bulk put: ${fmtOps(best)} ops/s   (目标 1,000,000/s  ≥ ${(best / 1e6).toFixed(2)}×)`)
  console.log(line)
}

module.exports = { main, parseArgs, benchMode }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}