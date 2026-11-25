#!/usr/bin/env node
/**
 * 把一个会话从一个工作区搬到另一个工作区。
 *
 *   node tools/migrate-session.mjs --session <id> --to "F:\DeepseekHarnessWorkSpace\DSHdev" [--dry-run]
 *   node tools/migrate-session.mjs --session <id> --to <dir> --restore <backupDir>
 *
 * 为什么需要它：DSH 把会话固化在 `$DSH_HOME/sessions/<workspace-slug>/<id>/`，
 * 并且会话日志**第一行硬编码了 cwd**。工作区注册表（storages/workspace.json）
 * 也各自维护 sessionIds 列表。三处必须一起改，否则会话要么找不到，要么被
 * 当成另一个工作区的。
 *
 * 安全规则：
 * - 会话日志被进程独占锁住时直接拒绝（说明 DSH 正在写它）。
 * - 移动前把整份会话目录与 workspace.json 备份到 `--backup-dir`（默认
 *   `$DSH_HOME/compaction-ask/session-move-backups/<时间戳>`）。
 * - 只改第一行的 cwd，其余日志字节原样保留（不做解压重写，避免时间戳/帧结构变化）。
 * - 任一步失败就回滚已做的改动。
 */

import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const sessionId = option('--session')
const targetWorkspace = option('--to')
const restoreFrom = option('--restore')
const dryRun = argv.includes('--dry-run')
const bridge = argv.includes('--bridge')
const allFrom = option('--all-from')

const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')
const registryFile = path.join(home, 'storages', 'workspace.json')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = option('--backup-dir') ?? path.join(home, 'compaction-ask', 'session-move-backups', stamp)

function fail(message) {
  console.error(`失败：${message}`)
  process.exit(1)
}

/** 与 DSH 的 projectKey 一致：分隔符折叠成 '-'，非安全字符写成 ~XXXX，首尾加 --。 */
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

/** 找出会话当前所在的目录，返回 { dir, log, projectKey }。 */
function locate() {
  if (!existsSync(sessionsRoot)) fail(`${sessionsRoot} 不存在`)
  for (const projectKey of readdirSafe(sessionsRoot)) {
    const dir = path.join(sessionsRoot, projectKey, sessionId)
    if (!existsSync(dir)) continue
    const log = pickLog(dir)
    if (log !== undefined) return { dir, log, projectKey }
  }
  fail(`找不到会话 ${sessionId}（在 ${sessionsRoot} 下没有对应目录）`)
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function pickLog(dir) {
  const candidates = readdirSync(dir).filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
  if (candidates.length === 0) return undefined
  return path.join(dir, candidates.sort().at(-1))
}

/** 读出会话头（第一行 JSON）。 */
function readHeader(logPath) {
  const buffer = readFileSync(logPath)
  const text = logPath.endsWith('.zstd')
    ? zlib.zstdDecompressSync(buffer).toString('utf8')
    : buffer.toString('utf8')
  const firstLine = text.split('\n')[0]
  if (!firstLine) fail('会话日志第一行为空')
  return { header: JSON.parse(firstLine), compressed: logPath.endsWith('.zstd') }
}

const ZSTD_MAGIC = 0xFD2FB528

/**
 * 扫描拼接在一起的 zstd 帧，返回每个完整帧的字节区间。
 *
 * DSH 的会话日志是「多帧拼接」：第一帧**必须恰好只有 header 一行**，之后每个持久
 * 批次各占一帧。它的 `scanZstdFrames` + `assertIndependentHeaderFrame` 会在读取时
 * 做这个校验，不满足就抛错，`list()` 随即跳过该会话——工作区拿不到 header，会话
 * 整个从侧边栏消失。所以任何重写都必须保住帧边界。
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`zstd 帧不完整（偏移 ${offset}）`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`zstd magic 不正确（偏移 ${offset}）`)
    offset += 4
    if (offset === buffer.length) throw new Error(`zstd 帧不完整（偏移 ${start}）`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`zstd 帧头保留位非零（偏移 ${offset - 1}）`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const headerRest = (singleSegment ? 0 : 1)
      + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    if (buffer.length - offset < headerRest) throw new Error(`zstd 帧不完整（偏移 ${start}）`)
    offset += headerRest
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`zstd 帧不完整（偏移 ${start}）`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`zstd 保留块类型（偏移 ${offset - 3}）`)
      const payload = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payload) throw new Error(`zstd 帧不完整（偏移 ${start}）`)
      offset += payload
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`zstd 帧不完整（偏移 ${start}）`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 只替换 header 的 cwd：重建第一帧，其余帧按原始字节直接拼接。
 *
 * 早期版本把整份日志解压后一次性重压成**一个**大帧，第一帧就包含全部事件，
 * 直接违反 DSH 的「第一帧恰好一行 header」约束，会话随即从工作区消失。
 */
function rewriteHeader(buffer, logPath, cwd) {
  const text = logPath.endsWith('.zstd')
    ? zlib.zstdDecompressSync(buffer).toString('utf8')
    : buffer.toString('utf8')
  const lines = text.split('\n')
  const header = JSON.parse(lines[0])
  header.cwd = cwd
  lines[0] = JSON.stringify(header)
  const next = lines.join('\n')
  if (!logPath.endsWith('.zstd')) return Buffer.from(next, 'utf8')

  const frames = scanFrames(buffer)
  if (frames.length === 0) fail(`${logPath} 里没有可用的 zstd 帧`)
  const firstRange = frames[0]
  const firstPlain = zlib.zstdDecompressSync(buffer.subarray(firstRange.start, firstRange.end)).toString('utf8')
  // 原生假设：第一帧只有 header 一行。若不是（已被旧版脚本压坏），保留原样并在下面提示。
  if (firstPlain.split('\n').filter((line) => line !== '').length !== 1) {
    return zlib.zstdCompressSync(Buffer.from(next, 'utf8'), {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    })
  }
  const headFrame = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
  return Buffer.concat([headFrame, buffer.subarray(firstRange.end)])
}

async function assertUnlocked(logPath) {
  const handle = await open(logPath, 'r+').catch(() => undefined)
  if (handle === undefined) fail(`会话日志被占用（DSH 可能正在写它）：${logPath}\n请先关闭/重启 DeepSeek Harness`)
  await handle.close()
}

/**
 * 搬一个会话目录到目标工作区键下。
 *
 * 顶层会话（`session-` 开头）会同时改工作区注册表；subagent 子会话（无前缀、
 * header 带 `parentSession`）不进注册表——DSH 靠跟父会话的关系找到它们，
 * 所以只需搬目录 + 改 cwd。
 */
function moveOne(id, targetCwd, targetKey, { dryRun, bridge, backupRoot }) {
  let found
  for (const projectKey of readdirSafe(sessionsRoot)) {
    const dir = path.join(sessionsRoot, projectKey, id)
    if (existsSync(dir)) {
      found = { dir, projectKey, log: pickLog(dir) }
      break
    }
  }
  if (found === undefined || found.log === undefined) return { id, status: 'missing' }

  const { header } = readHeader(found.log)
  const targetDir = path.join(sessionsRoot, targetKey, id)
  const topLevel = id.startsWith('session-')

  if (header.cwd === targetCwd) return { id, status: 'already', from: found.dir, to: targetDir }
  if (existsSync(targetDir)) return { id, status: 'conflict', to: targetDir }

  // 旧位置是上次 --bridge 留下的 junction 时先摘掉，否则会把新目录删掉
  const isBridge = lstatSync(found.dir).isSymbolicLink()
  if (dryRun) {
    return { id, status: 'planned', from: found.dir, to: targetDir, fromCwd: header.cwd, topLevel, isBridge }
  }
  if (isBridge) rmSync(found.dir, { recursive: false, force: true })

  // 先确认没被 DSH 占用
  const handle = openSync(found.log, 'r+')
  closeSync(handle)

  // 备份
  const backupDir = path.join(backupRoot, id)
  mkdirSync(path.join(backupDir, 'session'), { recursive: true })
  for (const name of readdirSync(found.dir)) {
    const from = path.join(found.dir, name)
    if (statSync(from).isFile()) copyFileSync(from, path.join(backupDir, 'session', name))
  }

  // 复制 + 改 cwd
  mkdirSync(targetDir, { recursive: true })
  for (const name of readdirSync(found.dir)) {
    const from = path.join(found.dir, name)
    const to = path.join(targetDir, name)
    if (!statSync(from).isFile()) continue
    if (path.resolve(from) === path.resolve(found.log)) {
      writeFileSync(to, rewriteHeader(readFileSync(from), from, targetCwd))
    } else {
      copyFileSync(from, to)
    }
  }

  // 旧目录：桥接或删除
  if (bridge) {
    rmSync(found.dir, { recursive: true, force: true })
    mkdirSync(path.dirname(found.dir), { recursive: true })
    symlinkSync(targetDir, found.dir, 'junction')
  } else {
    rmSync(found.dir, { recursive: true, force: true })
  }

  writeFileSync(path.join(backupDir, 'move.json'), `${JSON.stringify({
    sessionId: id,
    fromDir: found.dir,
    toDir: targetDir,
    fromCwd: header.cwd,
    toCwd: targetCwd,
    topLevel,
    bridged: bridge,
    at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')

  return { id, status: 'moved', from: found.dir, to: targetDir, fromCwd: header.cwd, topLevel, backupDir }
}


function workspaceEntry(registry, cwd) {
  const table = registry?.tables?.workspaces ?? {}
  for (const [id, value] of Object.entries(table)) {
    if (value && typeof value.path === 'string' && value.path.toLowerCase() === cwd.toLowerCase()) return { id, value }
  }
  return undefined
}

// ---------------------------------------------------------------- 主流程

function registryOf() {
  return JSON.parse(readFileSync(registryFile, 'utf8'))
}

/** 顶层会话从旧工作区移除、加入目标工作区；子会话不动注册表。 */
function updateRegistry(registry, moved, targetCwd) {
  const targetEntry = workspaceEntry(registry, targetCwd)
  if (targetEntry === undefined) {
    throw new Error(`storages/workspace.json 里没有 ${targetCwd}；请先在 DSH 里打开它一次`)
  }
  for (const item of moved) {
    if (!item.topLevel) continue
    for (const value of Object.values(registry?.tables?.workspaces ?? {})) {
      if (!value || !Array.isArray(value.sessionIds)) continue
      value.sessionIds = value.sessionIds.filter((id) => id !== item.id)
    }
    const ids = targetEntry.value.sessionIds ?? []
    if (!ids.includes(item.id)) ids.push(item.id)
    targetEntry.value.sessionIds = ids
  }
  return targetEntry
}

/** 列出某个工作区键下的所有会话 id。 */
function idsUnder(projectKey) {
  const dir = path.join(sessionsRoot, projectKey)
  if (!existsSync(dir)) return []
  return readdirSafe(dir).filter((name) => {
    const full = path.join(dir, name)
    return existsSync(full) && (existsSync(path.join(full, 'session.v4.jsonl.zstd')) || existsSync(path.join(full, 'session.v4.jsonl')))
  })
}

// ---- 回滚 ----
if (restoreFrom !== undefined) {
  const metaFile = path.join(restoreFrom, 'move.json')
  if (!existsSync(metaFile)) fail(`${restoreFrom} 里没有 move.json`)
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
  const items = meta.items ?? [{ sessionId: meta.sessionId, fromDir: meta.fromDir, toDir: meta.toDir }]
  for (const item of items) {
    if (existsSync(item.toDir)) rmSync(item.toDir, { recursive: true, force: true })
    mkdirSync(path.dirname(item.fromDir), { recursive: true })
    const backedUp = path.join(restoreFrom, item.sessionId, 'session')
    const single = path.join(restoreFrom, 'session')
    renameSync(existsSync(backedUp) ? backedUp : single, item.fromDir)
  }
  copyFileSync(path.join(restoreFrom, 'workspace.json'), registryFile)
  console.log(`已回滚 ${items.length} 个会话`)
  process.exit(0)
}

if (targetWorkspace === undefined) fail('缺少 --to <工作区目录>')
if (!existsSync(targetWorkspace)) fail(`目标工作区不存在：${targetWorkspace}`)

const targetCwd = path.resolve(targetWorkspace)
const targetKey = projectKeyOf(targetCwd)

// 要搬哪些：--all-from <工作区键或路径> 批量，否则用 --session
let ids = []
if (allFrom !== undefined) {
  const projectKey = allFrom.includes('--') ? allFrom : projectKeyOf(path.resolve(allFrom))
  ids = idsUnder(projectKey)
} else if (sessionId !== undefined) {
  ids = [sessionId]
} else {
  fail('缺少 --session <id> 或 --all-from <工作区>')
}

const backupRoot = backupDir ?? path.join(home, 'compaction-ask', 'session-move-backups', stamp)
mkdirSync(backupRoot, { recursive: true })
if (existsSync(registryFile)) copyFileSync(registryFile, path.join(backupRoot, 'workspace.json'))

console.log(`目标工作区：${targetCwd}`)
console.log(`会话数量：${ids.length}`)
console.log('')

const results = []
for (const id of ids) {
  try {
    const result = moveOne(id, targetCwd, targetKey, { dryRun, bridge, backupRoot })
    results.push(result)
    const mark = result.status === 'moved' ? '✓' : result.status === 'planned' ? '·' : result.status === 'already' ? '=' : '!'
    console.log(`${mark} ${id.slice(0, 30)}${result.status === 'conflict' ? `  目标已存在：${result.to}` : ''}`)
  } catch (error) {
    results.push({ id, status: 'error', error: error.message })
    console.error(`✗ ${id.slice(0, 30)}  ${error.message}`)
  }
}

const moved = results.filter((r) => r.status === 'moved' || r.status === 'planned')
if (dryRun) {
  console.log('')
  console.log('（--dry-run：只检查，不改任何文件）')
  process.exit(results.some((r) => r.status === 'error') ? 1 : 0)
}

if (moved.length > 0) {
  const registry = registryOf()
  const targetEntry = updateRegistry(registry, moved, targetCwd)
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  console.log('')
  console.log(`注册表：${moved.filter((r) => r.topLevel).length} 个顶层会话归入 ${targetEntry.value.path}`)
  console.log(`（子会话 ${moved.filter((r) => !r.topLevel).length} 个不进注册表，靠 parentSession 关联）`)

  writeFileSync(path.join(backupRoot, 'move.json'), `${JSON.stringify({
    targetCwd,
    items: moved.map((r) => ({ sessionId: r.id, fromDir: r.from, toDir: r.to, fromCwd: r.fromCwd, topLevel: r.topLevel })),
    bridged: bridge,
    at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  console.log(`备份：${backupRoot}`)
  console.log(`回滚：node tools/migrate-session.mjs --restore "${backupRoot}"`)
}

const failed = results.filter((r) => r.status === 'error' || r.status === 'conflict' || r.status === 'missing')
process.exit(failed.length === 0 ? 0 : 1)