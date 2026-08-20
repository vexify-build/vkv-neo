<div align="center">

# ⚡ vkv-neo

**超高速多引擎 Key-Value Store · Ultra-fast embedded Key-Value Store**

三引擎 · Three engines: **JS** · **WASM** · **Rust (N-API `.node`)**

Bulk 写入峰值 **154 万条/s** · Peak bulk write **1.54M ops/s**（目标 100 万条/s · target 1M/s）

**Powered By Vexify** · Apache-2.0

</div>

---

## 简介 · Introduction

`vkv-neo` 是一个内存态 Key-Value 存储的 npm 包，同一套 API 下提供三种引擎：

| Engine 引擎 | 实现 Implementation | 说明 Notes |
|---|---|---|
| `js` | 纯 JavaScript `Map` | 零依赖、任意环境可用 / works everywhere |
| `wasm` | Rust → WebAssembly (`wasm32-unknown-unknown`) | base64 内嵌，无需构建产物 / embedded, no build step |
| `rust` | Rust + N-API (`vkv-neo.node`) | 最速 / fastest, 需要预编译二进制 / requires prebuilt binary |

自动降级策略 / auto-fallback：`auto` 模式按 `rust → wasm → js` 依次选择可用引擎。

## 存储后端 · Storage backends

三个引擎之上，可选三种持久化策略（默认 `ram`）：

| Storage 存储 | 说明 Description | 持久化 Persistence |
|---|---|---|
| `ram` | 纯内存 / in-memory only（默认） | 无 / none |
| `disk` | Write-Ahead Log 追加落盘，崩溃可回放 / durable WAL + replay | 每次写 / every write |
| `hybrid` | 内存读写 + 定期快照 + 显式 `flush()` / 退出钩子落盘 / snapshot autosave | 间隔/退出时 / 定期或按需 |

磁盘格式（little-endian）：`.wal` 追加日志（`VKVNWAL1` + op 流：PUT/DEL/CLEAR），`.snap` 原子快照（`VKVNSNAP` + entries，临时文件 rename 替换）。文件路径取 `file` 参数拼后缀。

```js
const { createKV } = require('vkv-neo')

const kv = createKV()                                  // ram · auto engine
const disk = createKV({ mode: 'rust', storage: 'disk', file: './db', sync: true })
const hybrid = createKV({
  mode: 'wasm',
  storage: 'hybrid',
  file: './db',
  flushIntervalMs: 2000,       // 后台自动快照间隔 / autosave interval
})

disk.set('a', '1')             // 立即落盘 immediately durable
disk.flush()                   // 手动冲刷手动 / flush (disk: fsync WAL)
disk.close()                   // 冲刷并释放 / flush & release

// 重启后恢复数据 / data survives restart:
const again = createKV({ mode: 'rust', storage: 'disk', file: './db' })
again.get('a')                 // -> '1'
```

- `disk`：`sync: true`（默认）每次操作 fsync，最安全；`sync: false` 更快但掉电可能丢尾部日志
- `hybrid`：读写全走内存（最快），崩溃最多丢失一个快照间隔内的数据；正常退出时自动落盘
- 三种存储 × 三种引擎均可自由组合

## 安装 · Install

```bash
npm install vkv-neo
```

预编译的 `.node` 二进制目前提供 `linux-x64`；其他平台可用 `wasm` / `js` 引擎，或本地构建（见下文 / build locally）。

## 快速开始 · Quick Start

```bash
npm install vkv-neo
```

预编译的 `.node` 二进制目前提供 `linux-x64`；其他平台可用 `wasm` / `js` 引擎，或本地构建（见下文 / build locally）。

## 快速开始 · Quick Start

```js
const { createKV } = require('vkv-neo')

const kv = createKV()                // auto: rust > wasm > js
// const kv = createKV({ mode: 'wasm' })
// const kv = createKV({ mode: 'rust' })
// const kv = createKV({ mode: 'js' })

kv.set('hello', 'world')             // 字符串 string
kv.set('count', 42)                  // 数字 -> "42"
kv.get('hello')                      // -> 'world'
kv.has('hello')                      // -> true
kv.del('hello')                      // -> true
kv.size                              // -> 条目数 entry count
kv.clear()                           // 清空 clear all

// 批量写入 bulk write
kv.putMany([['a', '1'], ['b', '2'], ['c', '3']])
kv.putMany(new Map([['x', '9']]))

// 批量读取 bulk read
kv.getMany(['a', 'missing', 'c'])    // -> ['1', undefined, '3']

// 二进制安全 binary-safe
kv.set(Buffer.from([0xff, 0x00]), Buffer.from([0xde, 0xad]))
kv.get(Buffer.from([0xff, 0x00]))    // -> <Buffer de ad>
```

### 编码规则 · Encoding rules

- `string` → 以 UTF-8 存储 / stored as UTF-8
- `Buffer` / `Uint8Array` → 原样字节存储 / raw bytes
- `number` / `boolean` → 转为字符串 / coerced to String
- 读取时：合法 UTF-8 返回 `string`，否则返回 `Buffer` / on read: valid UTF-8 → `string`, otherwise → `Buffer`
- 三种引擎语义一致 · semantics are identical across all three engines

## 性能 · Performance

本机实测（`node scripts/bench.js`），100 万条数据，单进程：

```
├────────┬──────────────┬──────────────┬──────────────┬────────┐
│ engine │  single set  │   bulk put   │   bulk get   │ verify │
│ js     │      832.8K/s │      768.6K/s │      507.0K/s │ ✓     │
│ wasm   │      700.5K/s │       1.54M/s │       1.18M/s │ ✓     │
│ rust   │      415.6K/s │       1.03M/s │       2.11M/s │ ✓     │
└────────┴──────────────┴──────────────┴──────────────┴────────┘
```

- 目标 **100 万条/s（100W 条/s）** 在 `wasm` 与 `rust` 的批量路径上稳定达成 / the 1M ops/s target is met on the bulk path of `wasm` & `rust`
- 单条写入受 JS↔原生边界转换开销影响 / single-op throughput is bounded by JS↔native marshalling
- WASM 引擎内部 raw 路径：PUT 350 万/s · GET 6100 万/s / raw wasm internals: PUT 3.5M/s · GET 61M/s

> 运行本机基准 / run it yourself: `npx vkv bench` 或 `node scripts/bench.js`

## CLI

```bash
vkv info                   # 引擎状态 engine status
vkv set <key> <value>      # 写入（--storage disk/hybrid --file ./db 可持久化）
vkv get <key>              # 读取
vkv has <key>              # 存在性
vkv del <key>              # 删除
vkv size                   # 条数
vkv clear -f               # 清空
vkv bench -n 1000000       # 基准测试 / benchmark  --mode js|wasm|rust
vkv --help

# 持久化示例 persisted example (每个命令独立进程、退出自动落盘)
vkv set apple 5 --storage hybrid --file ./db
vkv get apple --storage hybrid --file ./db     # -> 5
```

> CLI 基于 [yargs](https://github.com/yargs/yargs)。
> 注意：`ram` 存储为进程内存态，`set` 与 `get` 需要在同一进程内使用 API 完成 / with `ram` storage, data lives only inside one process — use `--storage disk|hybrid --file` for cross-process persistence.

## 架构 · Architecture

```
src/
  index.js                统一 API · unified API (createKV)
  lib/js.js               纯 JS 引擎 / Pure-JS engine
  lib/wasm.js             WASM 引擎加载器 / WASM engine loader
  lib/native.js           N-API 引擎加载器 / native .node loader
  lib/storage.js          持久化层 / persistence: ram · disk (WAL) · hybrid (snapshot)
  lib/bytes.js            编码 / encoding & bulk layout helpers
  wasm/vkv-neo-wasm.js    生成的 base64 内嵌 WASM / generated embedded wasm
  native/<platform>/      .node 二进制 / prebuilt binaries
wasm/   Rust crate → wasm32-unknown-unknown（exported C ABI）
native/ Rust crate → cdylib .node（N-API / Node-API）
core/   Rust 核心共享引擎（FxHash 哈希表）/ shared Rust KV core
bin/vkv.js                yargs CLI
scripts/                  构建 & 基准 / build & bench
```

### 批量内存布局 · Bulk buffer layout

读/写共用同一紧凑布局，全部 little-endian：

```
[u32 key_len][key][u32 val_len][val]  (put / 写入)
[u32 key_len][key]                    (get 查询 / query)
缺省项写入 0xFFFFFFFF 标记 / misses are marked 0xFFFFFFFF
```

底层一行调用即可灌入百万条 / one call moves a million records.

### 构建产物 · Building locally

```bash
npm install
npm run build:wasm        # Rust -> wasm32-unknown-unknown -> base64 embed
npm run build:native      # Rust + N-API -> native/<platform>/vkv-neo.node
npm test                  # node --test
npm run bench
```

依赖 Rust toolchain（含 `wasm32-unknown-unknown` target：`rustup target add wasm32-unknown-unknown`）。

## 限制 · Limitations

- `ram` 存储为进程内存态，不持久化 / `ram` storage is in-memory only
- `disk` / `hybrid` 为单文件嵌入式持久化，无分布式 / single-file embedded persistence, not distributed
- `hybrid` 崩溃最多丢失一个 `flushIntervalMs` 间隔内的写入 / hybrid may lose at most one flush interval worth of writes on a crash
- `wasm` / `rust` 引擎为进程级单例存储（同一进程共享一份数据）/ singleton store per process for wasm/rust engines
- 原生二进制目前内置 `linux-x64`，其他平台需本地构建 / native binary ships for `linux-x64`; build for others via `npm run build:native`

## License

[Apache-2.0](LICENSE) · Copyright 2026 Vexify

---

**⚡ Powered By Vexify**