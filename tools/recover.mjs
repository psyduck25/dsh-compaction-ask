#!/usr/bin/env node
/**
 * 从会话日志里还原被压缩掉的原文。命令行版本。
 *
 * 用途：不开 DSH、不依赖模型，直接对某个 `session.v4.jsonl.zstd` 取回内容。
 * 模型侧的 `context_recover` / `context_search` 工具走的是同一套 `lib/recover.js`，
 * 所以两边结果一致。
 *
 * 用法：
 *   node tools/recover.mjs <日志文件或会话目录>                      列出压缩记录
 *   node tools/recover.mjs <路径> --list                             同上
 *   node tools/recover.mjs <路径> --index 1 -o out.md                 还原第 1 次到文件
 *   node tools/recover.mjs <路径> --search retainRatio               搜关键词
 *   node tools/recover.mjs <路径> --search 报错 --limit 50
 *   node tools/recover.mjs <路径> --seq 42                           还原包含 seq 42 的那次
 *   node tools/recover.mjs <路径> --compaction <compactionId>        按 id 还原
 *
 * 路径可以给：
 *   - `session.v4.jsonl.zstd` 文件
 *   - 会话目录（自动找里面的日志）
 *   - 省略时用 $DSH_SESSION_ID 推断当前会话
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { listCompactions, recoverCompaction, searchHistory } from '../lib/recover.js'

const argv = process.argv.slice(2)

/** 取 `--name value` 形式的值。 */
function option(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}

function has(flag) {
  return argv.includes(flag)
}

function fail(message) {
  console.error(`失败：${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 参数

const positional = argv.filter((arg, index) => {
  if (arg.startsWith('-')) return false
  const previous = argv[index - 1]
  // --name value 里的 value 不算位置参数
  return !(previous !== undefined && previous.startsWith('--') && previous !== '--list')
})

const target = positional[0]
const output = option('-o', option('--output'))
const searchQuery = option('--search')
const limit = Number(option('--limit', '20'))
const index = option('--index')
const bySeq = option('--seq')
const byId = option('--compaction')

if (has('--help') || has('-h')) {
  printHelp()
  process.exit(0)
}

// ---------------------------------------------------------------- 定位日志

const home = process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')

/** 把一个路径解析成具体的日志文件。 */
function resolveLog(input) {
  if (input === undefined) {
    const id = process.env.DSH_SESSION_ID
    if (id === undefined) fail('没给路径，也没有 $DSH_SESSION_ID 可以推断')
    const found = findSessionDir(id)
    if (found === undefined) fail(`在 ${sessionsRoot} 下找不到会话 ${id}`)
    return found
  }
  const resolved = path.resolve(input)
  if (!existsSync(resolved)) fail(`路径不存在：${resolved}`)
  const stats = statSync(resolved)
  if (stats.isFile()) return resolved
  // 目录：找里面的日志
  const log = pickLog(resolved)
  if (log === undefined) fail(`目录里没有 session.v*.jsonl(.zstd)：${resolved}`)
  return log
}

function findSessionDir(id) {
  let projects
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const dir = path.join(sessionsRoot, project, id)
    if (!existsSync(dir)) continue
    const log = pickLog(dir)
    if (log !== undefined) return log
  }
  return undefined
}

function pickLog(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const candidates = names.filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name)).sort()
  return candidates.length === 0 ? undefined : path.join(dir, candidates.at(-1))
}

// ---------------------------------------------------------------- 读日志

const logPath = resolveLog(target)
const raw = readFileSync(logPath)
let text
try {
  text = logPath.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
} catch (error) {
  fail(`解压失败（文件可能损坏）：${error.message}`)
}

const events = text
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((event) => event !== null)

// 造一个和 DSH session 同形的对象，复用 lib/recover.js
const session = {
  log: events,
  seq: events.length,
  snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
}

console.log(`日志：${logPath}`)
console.log(`事件：${events.length} 条（${(raw.length / 1024 / 1024).toFixed(2)} MB 压缩 → ${(text.length / 1024 / 1024).toFixed(2)} MB 解压）`)
console.log('')

// ---------------------------------------------------------------- 执行

if (searchQuery !== undefined) {
  const result = searchHistory(session, searchQuery, Number.isFinite(limit) ? limit : 20)
  if (!result.ok) fail(result.error)
  if (result.matches.length === 0) {
    console.log(`被压缩的历史里没有找到「${searchQuery}」`)
    process.exit(0)
  }
  console.log(`找到 ${result.matches.length} 条：`)
  console.log('')
  for (const match of result.matches) {
    console.log(`[第 ${match.compaction} 次压缩 · seq ${match.seq} · ${match.type}]`)
    console.log(match.excerpt)
    console.log('')
  }
  if (result.truncated) console.log(`（已到 ${limit} 条上限，可用 --limit 调大）`)
  process.exit(0)
}

const wantsRecover = index !== undefined || bySeq !== undefined || byId !== undefined

if (!wantsRecover && !has('--list') && target !== undefined) {
  // 给了路径但没说要干什么：默认列出记录
  printList()
  process.exit(0)
}

if (!wantsRecover) {
  printList()
  process.exit(0)
}

const selector = {}
if (index !== undefined) selector.index = Number(index)
if (bySeq !== undefined) selector.seq = Number(bySeq)
if (byId !== undefined) selector.compactionId = byId

const result = recoverCompaction(session, selector)
if (!result.ok) fail(result.error)

if (output !== undefined) {
  const target = path.resolve(output)
  writeFileSync(target, `${result.header}\n\n${result.text}\n`, 'utf8')
  console.log(result.header)
  console.log('')
  console.log(`已写入：${target}`)
  console.log(`（${result.totalChars} 字符，${result.eventCount} 条事件）`)
} else {
  console.log(result.header)
  console.log('')
  console.log(result.text)
}

// ---------------------------------------------------------------- 辅助

function printList() {
  const records = listCompactions(session)
  if (records.length === 0) {
    console.log('这个会话还没有被压缩过，没有可还原的内容。')
    return
  }
  console.log(`共有 ${records.length} 次压缩：`)
  console.log('')
  for (const record of records) {
    console.log(`  第 ${record.id} 次  seq ${record.start}–${record.end}  ${record.seqCount} 条事件  ` +
      `${record.tokens} tokens → ${record.summaryChars} 字摘要  ${record.provider ?? ''}/${record.model ?? ''}`)
  }
  console.log('')
  console.log('还原某一次：node tools/recover.mjs <路径> --index N')
  console.log('搜索关键词：node tools/recover.mjs <路径> --search 关键词')
}

function printHelp() {
  console.log(`从会话日志还原被压缩掉的原文

用法：
  node tools/recover.mjs <日志文件或会话目录> [选项]

选项：
  --list                    列出所有压缩记录（默认行为）
  --index N                 还原第 N 次压缩（从 1 开始）
  --seq N                   还原包含事件 seq N 的那一次
  --compaction <id>         按 compactionId 还原
  --search <关键词>         在被压缩的历史里搜索
  --limit N                 搜索结果上限（默认 20）
  -o, --output <文件>       把还原结果写入文件而不是打印
  -h, --help                显示这段帮助

路径可以是：
  - session.v4.jsonl.zstd 文件
  - 会话目录（自动找里面的日志）
  - 省略：用 $DSH_SESSION_ID 推断当前会话

示例：
  node tools/recover.mjs "C:\\Users\\你\\.dsh\\sessions\\--F-xxx--\\session-abc\\session.v4.jsonl.zstd"
  node tools/recover.mjs <路径> --index 1 -o history-1.md
  node tools/recover.mjs <路径> --search retainRatio`)
}
