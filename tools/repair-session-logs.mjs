#!/usr/bin/env node
/**
 * 修复 dsh-compaction-ask 的 migrate-session.mjs 造成的会话日志损坏。
 *
 * 症状：被搬过的会话在 DSH 里整个工作区为空。
 * 原因：迁移脚本把整份日志解压后一次性 `zstdCompressSync` 重压，得到**一个**大帧；
 *       而 DSH 的格式要求第一帧**恰好只有 header 一行**，否则
 *       `assertIndependentHeaderFrame` 抛错 -> `list()` 跳过该会话 ->
 *       工作区拿不到 header -> 会话从侧边栏消失。
 * 做法：从插件自己留下的原始备份还原（备份是原生多帧结构），
 *       只把「第一帧」解压、改 cwd、按原样重新压成一帧，其余帧**字节原样拷贝**。
 *
 *   node repair-session-logs.cjs            # 只检查并报告
 *   node repair-session-logs.cjs --apply    # 真正写入（每份先 .bak-<时间戳>）
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const SESSIONS = path.join(HOME, 'sessions')
const BACKUPS = path.join(HOME, 'compaction-ask', 'session-move-backups')
const TARGET_CWD = process.argv.includes('--cwd')
  ? process.argv[process.argv.indexOf('--cwd') + 1]
  : 'F:\\DeepseekHarnessWorkSpace\\DSHdev'
const APPLY = process.argv.includes('--apply')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

// ---------------------------------------------------------------- zstd 帧扫描

/** 与 DSH 的 scanZstdFrames 同构：返回完整帧区间，以及可能的撕裂尾部。 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  let tornStart
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`不是合法的 zstd 帧：magic 不正确（偏移 ${offset}）`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`帧头保留位非零（偏移 ${offset - 1}）`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes
    if (buffer.length - offset < remaining) return { frames, tornStart: start }
    offset += remaining
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`保留块类型（偏移 ${offset - 3}）`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart }
}

function countNewlines(buffer) {
  let n = 0
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) n++
  return n
}

/** 与 DSH 的 compressZstdFrame 使用同样的校验和参数。 */
function compressFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/**
 * 判定一份日志 DSH 能不能读：第一帧必须恰好是「一行 header + 换行」，且没有撕裂尾部。
 * @returns {{ok: boolean, reason?: string, frames?: number}}
 */
function diagnose(buffer) {
  let scan
  try {
    scan = scanFrames(buffer)
  } catch (error) {
    return { ok: false, reason: error.message }
  }
  if (scan.frames.length === 0) return { ok: false, reason: '没有任何完整帧' }
  if (scan.tornStart !== undefined) return { ok: false, reason: `尾部帧不完整（偏移 ${scan.tornStart}）` }
  let first
  try {
    first = zlib.zstdDecompressSync(buffer.subarray(scan.frames[0].start, scan.frames[0].end))
  } catch (error) {
    return { ok: false, reason: `第一帧解不开：${error.message}` }
  }
  const endsWithNewline = first.length > 0 && first[first.length - 1] === 0x0a
  const newlines = countNewlines(first)
  if (!endsWithNewline || newlines !== 1) {
    return {
      ok: false,
      frames: scan.frames.length,
      reason: `第一帧不是「恰好一行 header」（${newlines} 个换行，共 ${scan.frames.length} 帧）`,
    }
  }
  return { ok: true, frames: scan.frames.length }
}

/**
 * 从一份「格式完好」的来源重建日志：只重写第一帧的 cwd，其余帧字节原样保留。
 */
function rebuildFrom(sourceBuffer, cwd) {
  const scan = scanFrames(sourceBuffer)
  if (scan.frames.length === 0) throw new Error('来源没有任何完整帧')
  if (scan.tornStart !== undefined) throw new Error('来源带有不完整的尾部帧')

  const firstRange = scan.frames[0]
  const firstPlain = zlib.zstdDecompressSync(sourceBuffer.subarray(firstRange.start, firstRange.end))
  const text = firstPlain.toString('utf8')
  if (!text.endsWith('\n')) throw new Error('来源第一帧没有以换行结尾')

  const lines = text.split('\n')
  if (lines.filter((line) => line !== '').length !== 1) {
    throw new Error('来源第一帧不止一行，不是原生结构')
  }
  const header = JSON.parse(lines[0])
  const before = header.cwd
  header.cwd = cwd

  const rest = sourceBuffer.subarray(firstRange.end)
  return {
    buffer: Buffer.concat([compressFrame(`${JSON.stringify(header)}\n`), rest]),
    header,
    previousCwd: before,
    frames: scan.frames.length,
  }
}

// ---------------------------------------------------------------- 待修清单

/**
 * 每一项：损坏的（当前生效的）日志 + 一份格式完好的来源。
 * 来源来自插件迁移前的自动备份，帧结构是 DSH 原生的。
 */
const JOBS = [
  {
    id: 'session-281799dd-2721-423c-9523-a137379d1f59',
    title: '（空会话 · 只失败在 cwd 不存在）',
    target: path.join(SESSIONS, '--F-DeepseekHarnessWorkSpace-DSHdev--', 'session-281799dd-2721-423c-9523-a137379d1f59', 'session.v4.jsonl.zstd'),
    source: path.join(BACKUPS, '2026-11-17T08-41-26-685Z', 'session-281799dd-2721-423c-9523-a137379d1f59', 'session', 'session.v4.jsonl.zstd'),
  },
  {
    id: 'session-7529cf04-08db-4976-8bef-0f4f3d003173',
    title: '（空会话 · 只失败在 cwd 不存在）',
    target: path.join(SESSIONS, '--F-DeepseekHarnessWorkSpace-DSHdev--', 'session-7529cf04-08db-4976-8bef-0f4f3d003173', 'session.v4.jsonl.zstd'),
    source: path.join(BACKUPS, '2026-11-17T08-41-26-685Z', 'session-7529cf04-08db-4976-8bef-0f4f3d003173', 'session', 'session.v4.jsonl.zstd'),
  },
  {
    id: 'session-d1481fa6-1ba8-4ddf-9a6e-5788d71c6b8e',
    title: 'DSH侧边栏XSD单分子生成模块',
    target: path.join(SESSIONS, '--F-DeepseekHarnessWorkSpace-DSHdev--', 'session-d1481fa6-1ba8-4ddf-9a6e-5788d71c6b8e', 'session.v4.jsonl.zstd'),
    source: path.join(BACKUPS, '2026-11-17T08-41-26-685Z', 'session-d1481fa6-1ba8-4ddf-9a6e-5788d71c6b8e', 'session', 'session.v4.jsonl.zstd'),
  },
  {
    id: '8840c7f6-917a-4d60-acb6-3f6242fac18c',
    title: '（d1481fa6 的子会话）',
    target: path.join(SESSIONS, '--F-DeepseekHarnessWorkSpace-DSHdev--', '8840c7f6-917a-4d60-acb6-3f6242fac18c', 'session.v4.jsonl.zstd'),
    source: path.join(BACKUPS, '2026-11-17T08-41-26-685Z', '8840c7f6-917a-4d60-acb6-3f6242fac18c', 'session', 'session.v4.jsonl.zstd'),
  },
  {
    id: 'session-40f87ea4-3c73-458a-99f6-3751829bd62d',
    title: 'DSH压缩模块（= Config 里那个「新会话」）',
    target: path.join(SESSIONS, '--F-DeepseekHarnessWorkSpace-DSHdev--', 'session-40f87ea4-3c73-458a-99f6-3751829bd62d', 'session.v4.jsonl.zstd'),
    source: path.join(BACKUPS, '2026-11-17T08-37-47-167Z', 'session', 'session.v4.jsonl.zstd'),
  },
]

// ---------------------------------------------------------------- 主流程

console.log(`DSH_HOME      : ${HOME}`)
console.log(`目标 cwd      : ${TARGET_CWD}`)
console.log(`模式          : ${APPLY ? '写入（--apply）' : '仅检查（加 --apply 才写）'}`)
console.log('')

let failures = 0
for (const job of JOBS) {
  console.log(`── ${job.id}`)
  console.log(`   ${job.title}`)

  if (!fs.existsSync(job.target)) { console.log('   ✗ 目标日志不存在，跳过\n'); failures++; continue }
  if (!fs.existsSync(job.source)) { console.log('   ✗ 备份来源不存在，跳过\n'); failures++; continue }

  const targetBuffer = fs.readFileSync(job.target)
  const before = diagnose(targetBuffer)
  console.log(`   现状: ${before.ok ? '正常' : '损坏'} — ${before.ok ? `${before.frames} 帧` : before.reason}`)
  if (before.ok) { console.log('   = 已经正常，不需要修\n'); continue }

  let rebuilt
  try {
    rebuilt = rebuildFrom(fs.readFileSync(job.source), TARGET_CWD)
  } catch (error) {
    console.log(`   ✗ 无法从备份重建：${error.message}\n`)
    failures++
    continue
  }

  const after = diagnose(rebuilt.buffer)
  const sourceLines = countNewlines(zlib.zstdDecompressSync(fs.readFileSync(job.source)))
  const rebuiltLines = countNewlines(zlib.zstdDecompressSync(rebuilt.buffer))
  console.log(`   重建: cwd ${rebuilt.previousCwd} -> ${rebuilt.header.cwd}`)
  console.log(`   结果: ${after.ok ? '可被 DSH 读取' : '仍然损坏'} — ${after.frames} 帧；行数 ${sourceLines} -> ${rebuiltLines}`)

  if (!after.ok) { console.log('   ✗ 重建后仍然损坏，放弃写入\n'); failures++; continue }
  if (sourceLines !== rebuiltLines) { console.log('   ✗ 行数不一致，放弃写入\n'); failures++; continue }

  if (!APPLY) { console.log('   · 未写入（检查模式）\n'); continue }

  const backupPath = `${job.target}.bak-${STAMP}`
  fs.copyFileSync(job.target, backupPath)
  fs.writeFileSync(job.target, rebuilt.buffer)
  const verify = diagnose(fs.readFileSync(job.target))
  console.log(`   ✓ 已写入；复核: ${verify.ok ? '正常' : '失败'}`)
  console.log(`     原件备份: ${backupPath}`)
  if (!verify.ok) failures++
  console.log('')
}

// junction 残留：工作区键与自己 header.cwd 不一致时会多出一条会话，顺手摘掉
const junction = path.join(SESSIONS, '--F-DeepseekHarnessWorkSpace-SoftwareInstallation--', 'session-40f87ea4-3c73-458a-99f6-3751829bd62d')
console.log('── junction 残留检查')
if (fs.existsSync(junction) && fs.lstatSync(junction).isSymbolicLink()) {
  if (APPLY) {
    fs.rmSync(junction, { recursive: false, force: true })
    console.log('   ✓ 已移除 SoftwareInstallation 下的 junction 残影')
  } else {
    console.log('   · 存在 junction（移进去再检查「Config」，会多出这条会话）')
  }
} else {
  console.log('   = 没有 junction 残留')
}

console.log('')
console.log(failures === 0 ? '完成。' : `完成，但有 ${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)

