#!/usr/bin/env node
'use strict'

/**
 * vkv-neo CLI — Powered By Vexify.
 *
 *   vkv info                      查看引擎状态 / show engine status
 *   vkv set <key> <value>         写入 / write
 *   vkv get <key>                 读取 / read
 *   vkv has <key>                 判断存在 / check existence
 *   vkv del <key>                 删除 / delete
 *   vkv size                      条目数 / entry count
 *   vkv clear                     清空 / clear
 *   vkv bench [--count N] [--batch M] [--mode js|wasm|rust]   基准测试
 *   --mode js|wasm|rust|auto  引擎选择 / engine selection
 */

const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const vkv = require('../src/index')

const BANNER = '⚡ vkv-neo — 超高速多引擎 KV · Powered By Vexify'

const globalMode = {
  alias: 'm',
  describe: '引擎模式 / engine mode: js | wasm | rust | auto',
  type: 'string',
  default: 'auto',
}

const globalStorage = {
  alias: 's',
  describe: '存储后端 / storage: ram | disk | hybrid',
  type: 'string',
  default: 'ram',
}

const globalFile = {
  alias: 'f',
  describe: '数据文件路径 / data file path (disk/hybrid)',
  type: 'string',
}

function open(argv) {
  return vkv.createKV({ mode: argv.mode, storage: argv.storage, file: argv.file, sync: argv.sync })
}

yargs(hideBin(process.argv))
  .usage(`${BANNER}\n\nUsage: vkv <command> [options]`)
  .command(
    'info',
    '查看引擎状态 / show engine status',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile),
    (argv) => {
      const avail = vkv.available()
      const lines = [BANNER, '']
      lines.push(' engines:')
      for (const [name, ok] of Object.entries(avail)) {
        lines.push(`   ${name.padEnd(5)} ${ok ? '✓ available' : '✗ unavailable'}`)
      }
      try {
        const kv = open(argv)
        lines.push('')
        lines.push(` selected: ${kv.engine}  (speed target ≥ 1,000,000 ops/s · bulk)`)
      } catch (e) {
        lines.push('')
        lines.push(` selected: none — ${e.message}`)
      }
      lines.push('')
      lines.push(' Powered By Vexify · Apache-2.0')
      console.log(lines.join('\n'))
    }
  )
  .command(
    'set <key> <value>',
    '写入键值 / set key → value',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile).option('sync', { describe: '每次写入 fsync (disk) / fsync per write', type: 'boolean' }).positional('key', { type: 'string' }).positional('value', { type: 'string' }),
    (argv) => {
      open(argv).set(argv.key, argv.value)
      console.log(`✓ ${argv.key} = ${argv.value}`)
    }
  )
  .command(
    'get <key>',
    '读取值 / get value',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile).positional('key', { type: 'string' }),
    (argv) => {
      const v = open(argv).get(argv.key)
      if (v === undefined) {
        console.error(`✗ ${argv.key}: not found`)
        process.exitCode = 1
      } else {
        console.log(String(v))
      }
    }
  )
  .command(
    'has <key>',
    '判断键是否存在 / check existence',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile).positional('key', { type: 'string' }),
    (argv) => {
      console.log(open(argv).has(argv.key) ? 'true' : 'false')
    }
  )
  .command(
    'del <key>',
    '删除键 / delete key',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile).positional('key', { type: 'string' }),
    (argv) => {
      console.log(open(argv).del(argv.key) ? `✓ ${argv.key} deleted` : `✗ ${argv.key} not found`)
    }
  )
  .command(
    'size',
    '条目数 / entry count',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile),
    (argv) => {
      console.log(open(argv).size)
    }
  )
  .command(
    'clear',
    '清空所有键值 / clear all',
    (y) => y.option('mode', globalMode).option('storage', globalStorage).option('file', globalFile).option('force', { describe: '跳过确认 / skip confirm', type: 'boolean' }),
    (argv) => {
      const kv = open(argv)
      if (!argv.force) {
        const readline = require('readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl.question(`确认清空 ${kv.size} 条记录? (y/N) / confirm clear ${kv.size} entries? `, (a) => {
          if (a.toLowerCase() === 'y') {
            kv.clear()
            console.log('✓ cleared')
          } else {
            console.log('aborted')
          }
          rl.close()
        })
        return
      }
      kv.clear()
      console.log('✓ cleared')
    }
  )
  .command(
    'bench',
    '基准测试 / run benchmark',
    (y) =>
      y
        .option('mode', globalMode)
        .option('count', { alias: 'n', describe: '写入条数 / total entries', type: 'number', default: 1000000 })
        .option('batch', { alias: 'b', describe: '批量写入批次 / batch size', type: 'number', default: 100000 })
        .option('json', { describe: 'JSON 输出 / JSON output', type: 'boolean', default: false }),
    async (argv) => {
      const { main: runBench } = require('../scripts/bench')
      const mode = argv.mode && argv.mode !== 'auto' ? argv.mode : 'all'
      await runBench({ mode, count: argv.count, batch: argv.batch, json: argv.json })
    }
  )
  .demandCommand(1, '请指定命令 / specify a command (info, set, get, del, has, size, clear, bench)')
  .strict()
  .help('h')
  .alias('h', 'help')
  .version(false)
  .parse()