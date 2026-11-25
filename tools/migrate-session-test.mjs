/**
 * migrate-session.mjs 的帧结构回归测试（不需要 DSH）。
 *
 *   node tools/migrate-session-test.mjs
 *
 * 守的是这个 bug：早期版本把整份日志解压后一次性重压成**一个** zstd 帧，
 * 而 DSH 要求第一帧**恰好只有 header 一行**（assertIndependentHeaderFrame），
 * 于是 list() 跳过该会话、工作区拿不到 header，会话从侧边栏整个消失。
 * 这里造一份原生多帧日志，验证搬迁后第一帧仍然只有一行、其余帧字节不变。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, 'migrate-session.mjs')

let failures = 0
const ok = (name) => console.log(`  ok   ${name}`)
const fail = (name, detail) => {
  failures += 1
  console.error(`  FAIL ${name}: ${detail}`)
}

const ZSTD_MAGIC = 0xFD2FB528
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

/** 与 DSH 的 scanZstdFrames 同构：数出完整帧的字节区间。 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad magic')
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    offset += (singleSegment ? 0 : 1)
      + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/** 按 DSH 的读取规则判定：第一帧恰好一行 header + 换行。 */
function headerFrameIsSingleLine(buffer) {
  const frames = scanFrames(buffer)
  if (frames.length === 0) return { ok: false, why: '没有帧' }
  const first = zlib.zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end))
  const newlines = [...first].filter((byte) => byte === 0x0a).length
  const endsWithNewline = first.length > 0 && first[first.length - 1] === 0x0a
  return {
    ok: endsWithNewline && newlines === 1,
    why: `${newlines} 个换行 / ${frames.length} 帧`,
    frames,
  }
}

// ---------------------------------------------------------------- 造场景

const home = mkdtempSync(path.join(os.tmpdir(), 'migrate-session-test-'))
const wsFrom = path.join(home, 'space', 'Old')
const wsTo = path.join(home, 'space', 'New')
mkdirSync(wsFrom, { recursive: true })
mkdirSync(wsTo, { recursive: true })
mkdirSync(path.join(home, 'storages'), { recursive: true })

const registry = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-old', 'ws-new'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      'ws-old': { path: wsFrom, title: 'Old', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      'ws-new': { path: wsTo, title: 'New', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    },
  },
}
writeFileSync(path.join(home, 'storages', 'workspace.json'), `${JSON.stringify(registry, null, 2)}\n`)

/** 与 migrate-session.mjs 的 projectKeyOf 完全一致（也是 DSH 的 projectKey 规则）。 */
function projectKeyOf(cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    const code = ch.charCodeAt(0)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const sessionId = 'session-11111111-2222-3333-4444-555555555555'
const sessionDir = path.join(home, 'sessions', projectKeyOf(wsFrom), sessionId)
mkdirSync(sessionDir, { recursive: true })

// 原生结构：header 独占第一帧，之后每个批次一帧
const header = {
  type: 'session',
  version: 4,
  id: sessionId,
  createdAt: 1,
  cwd: wsFrom,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}
const batches = [
  [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
  [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'end' } } }],
]
const native = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), CHECKSUM),
  ...batches.map((batch) => zlib.zstdCompressSync(Buffer.from(`${batch.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8'), CHECKSUM)),
])
const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd')
writeFileSync(logPath, native)

// ---------------------------------------------------------------- 断言

const before = headerFrameIsSingleLine(native)
if (before.ok) ok('样例日志是原生多帧结构')
else fail('样例日志是原生多帧结构', before.why)

const run = spawnSync(process.execPath, [script, '--session', sessionId, '--to', wsTo], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
})
if (run.status === 0) ok('迁移脚本执行成功')
else fail('迁移脚本执行成功', `exit ${run.status}\n${run.stderr}`)

const targetPath = path.join(home, 'sessions', projectKeyOf(wsTo), sessionId, 'session.v4.jsonl.zstd')
if (existsSync(targetPath)) ok('日志已落到目标工作区')
else fail('日志已落到目标工作区', targetPath)

if (existsSync(targetPath)) {
  const moved = readFileSync(targetPath)
  const after = headerFrameIsSingleLine(moved)
  if (after.ok) ok('第一帧仍然恰好一行 header（DSH 可读）')
  else fail('第一帧仍然恰好一行 header（DSH 可读）', after.why)

  const text = zlib.zstdDecompressSync(moved).toString('utf8')
  const movedHeader = JSON.parse(text.split('\n')[0])
  if (movedHeader.cwd === wsTo) ok('header 的 cwd 已改到目标工作区')
  else fail('header 的 cwd 已改到目标工作区', `got ${movedHeader.cwd}`)

  const expectedLines = 1 + batches.reduce((n, batch) => n + batch.length, 0)
  const actualLines = text.split('\n').filter((line) => line !== '').length
  if (actualLines === expectedLines) ok(`事件一行不丢（${actualLines} 行）`)
  else fail('事件一行不丢', `${actualLines} != ${expectedLines}`)

  // 关键：除第一帧外其余帧必须逐字节不变
  const nativeRest = native.subarray(before.frames[0].end)
  const movedRest = moved.subarray(after.frames[0].end)
  if (Buffer.compare(nativeRest, movedRest) === 0) ok('其余帧字节原样保留')
  else fail('其余帧字节原样保留', '尾部帧被重写')

  if (after.frames.length === 1 + batches.length) ok(`帧数保持不变（${after.frames.length}）`)
  else fail('帧数保持不变', `${after.frames.length} != ${1 + batches.length}`)
}

// 注册表：会话应从旧工作区移到新工作区
const registryAfter = JSON.parse(readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
if (registryAfter.tables.workspaces['ws-new'].sessionIds.includes(sessionId)) ok('注册表已把会话归到新工作区')
else fail('注册表已把会话归到新工作区', JSON.stringify(registryAfter.tables.workspaces['ws-new'].sessionIds))
if (!registryAfter.tables.workspaces['ws-old'].sessionIds.includes(sessionId)) ok('旧工作区不再占用该会话')
else fail('旧工作区不再占用该会话', JSON.stringify(registryAfter.tables.workspaces['ws-old'].sessionIds))

try { rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录，忽略 */ }

console.log('')
if (failures === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.error(`${failures} 项失败。`)
process.exit(1)
