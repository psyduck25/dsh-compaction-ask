/**
 * 原文还原与搜索的测试。
 *
 * 直接用真实会话的结构造假数据：`compaction/summary` + `surfaceOp: replace` +
 * 完整日志，验证「被压掉的原文能取回」这件事在代码层面成立。
 */

import { listCompactions, RECOVER_CONSTANTS, recoverCompaction, searchHistory } from '../lib/recover.js'

let failures = 0

function log(message) {
  console.log(`  ok   ${message}`)
}

function fail(message, detail) {
  failures += 1
  console.error(`  FAIL ${message}${detail === undefined ? '' : `: ${detail}`}`)
}

function check(condition, name, detail) {
  condition ? log(name) : fail(name, detail)
}

/** 造一条消息事件。 */
function message(seq, role, text) {
  return {
    type: role === 'user' ? 'user/message' : 'assistant/message',
    seq,
    data: { message: { role, content: [{ type: 'text', text }] } },
  }
}

/**
 * 造一个被压缩过的会话。
 *
 * 结构对齐真实日志：原文事件用 seq 递增，compaction/summary 记录
 * shadowedSeqs 和 shadowedRange，surface 上那条摘要以 user/message 出现。
 */
function makeSession() {
  const log = [
    message(0, 'user', 'system prompt 占位'),
    message(1, 'user', '原始需求：做一个压缩询问插件'),
    message(2, 'assistant', '好的，我先看 DSH 的压缩接口'),
    message(3, 'user', '记得支持 10% 下限'),
    message(4, 'assistant', '明白，thresholdRatio 要压到 0.08'),
    message(5, 'assistant', '错误：retainRatio (0.16) must be less than thresholdRatio'),
  ]

  // 第一次压缩：把 seq 1..5 换成一条摘要
  log.push({
    type: 'compaction/summary',
    seq: 6,
    data: {
      compactionId: 'cmp-1',
      summary: [{ type: 'text', text: '用户要一个压缩询问插件，要求支持 10% 下限；引擎报过 retainRatio 校验错误。' }],
      shadowedRange: { start: 1, end: 5 },
      shadowedSeqs: [1, 2, 3, 4, 5],
      shadowedTokenCount: 1200,
      provider: 'test',
      model: 'test-model',
    },
  })
  log.push(message(7, 'user', '继续，把区间策略也换成 BC'))
  log.push(message(8, 'assistant', '好的，实现 selectCompactSpan'))

  // 第二次压缩：把 seq 7..8 压掉
  log.push({
    type: 'compaction/summary',
    seq: 9,
    data: {
      compactionId: 'cmp-2',
      summary: [{ type: 'text', text: '用户要求区间策略改成 BC 式。' }],
      shadowedRange: { start: 7, end: 8 },
      shadowedSeqs: [7, 8],
      shadowedTokenCount: 400,
      provider: 'test',
      model: 'test-model',
    },
  })

  return { log, seq: log.length }
}

// ---- 列出压缩记录 ----
{
  const session = makeSession()
  const records = listCompactions(session)
  check(records.length === 2, '识别出 2 次压缩')
  check(records[0].id === 1 && records[1].id === 2, '记录按 1 起编号')
  check(records[0].seqCount === 5, '第一次压缩含 5 条事件')
  check(records[0].tokens === 1200, '记录被压掉的 token 数')
  check(records[0].summaryChars > 0, '记录摘要字数')
}

// ---- 还原指定次数 ----
{
  const session = makeSession()
  const first = recoverCompaction(session, { index: 1 })
  check(first.ok === true, '能还原第一次压缩')
  check(first.text.includes('原始需求：做一个压缩询问插件'), '第一次的原文能取回')
  check(first.text.includes('retainRatio (0.16) must be less than'), '原始报错原文能取回')
  check(first.header.includes('seq 1–5'), '头部说明区间')

  const second = recoverCompaction(session, { index: 2 })
  check(second.ok === true && second.text.includes('把区间策略也换成 BC'), '第二次的原文能取回')
  check(!second.text.includes('原始需求'), '第二次不含第一次的内容')

  const latest = recoverCompaction(session, {})
  check(latest.text.includes('把区间策略也换成 BC'), '不传 index 时取最近一次')
}

// ---- 按 compactionId / seq 定位 ----
{
  const session = makeSession()
  const byId = recoverCompaction(session, { compactionId: 'cmp-1' })
  check(byId.ok === true && byId.text.includes('原始需求'), '按 compactionId 能定位')

  const bySeq = recoverCompaction(session, { seq: 3 })
  check(bySeq.ok === true && bySeq.text.includes('10% 下限'), '按 seq 落在哪段能定位')
}

// ---- 边界 ----
{
  const session = makeSession()
  const outOfRange = recoverCompaction(session, { index: 99 })
  check(outOfRange.ok === false && outOfRange.error.includes('1–2'), '越界时报告可用范围')

  const notCompacted = recoverCompaction({ log: [message(0, 'user', 'hi')] }, {})
  check(notCompacted.ok === false && notCompacted.error.includes('还没有被压缩过'), '没压过时明确告知')

  const noLog = recoverCompaction({}, {})
  check(noLog.ok === false, '读不到日志时返回失败而不是抛错')
}

// ---- 搜索 ----
{
  const session = makeSession()
  const hit = searchHistory(session, 'retainRatio')
  check(hit.ok === true && hit.matches.length > 0, '能搜到关键词')
  check(hit.matches[0].compaction === 1, '标注命中的是第几次压缩')
  check(hit.matches[0].excerpt.includes('retainRatio'), '返回片段包含关键词')

  const miss = searchHistory(session, '不存在的词xyz')
  check(miss.ok === true && miss.matches.length === 0, '搜不到时返回空列表而不是报错')

  const empty = searchHistory(session, '   ')
  check(empty.ok === false, '空关键词返回失败')

  const cased = searchHistory(session, 'RETAINRATIO')
  check(cased.matches.length > 0, '大小写不敏感')
}

// ---- 搜索只在被压缩的历史里 ----
{
  const session = makeSession()
  const visibleOnly = searchHistory(session, 'system prompt 占位')
  check(visibleOnly.matches.length === 0, '当前可见的内容不在搜索结果里')
}

// ---- 截断保护 ----
{
  check(RECOVER_CONSTANTS.MAX_RECOVER_CHARS > 0, '有单次还原的字符上限')
  check(RECOVER_CONSTANTS.MAX_RECOVER_CHARS <= 500000, '上限不至于一次倒出整库')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 原文还原与搜索正确')
