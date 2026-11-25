/**
 * BC 区间选择策略的测试。
 *
 * 这段决定「压哪一段」，算错会压掉不该压的内容（丢当前意图/破坏 system），
 * 或者压了等于没压。边界必须钉死。
 */

import {
  BC_STRATEGY_CONSTANTS,
  hasSystemHead,
  incrementGateTokens,
  incrementTokens,
  indexSurface,
  selectCompactSpan,
} from '../lib/bc-strategy.js'

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

/**
 * 造一个假 session。
 *
 * @param spec - `[{type, tokens, source?}]`，顺序即 surface 顺序
 */
function makeSession(spec) {
  const events = new Map()
  const seqs = []
  spec.forEach((item, index) => {
    const seq = index * 10
    seqs.push(seq)
    events.set(seq, {
      type: item.type,
      seq,
      data: item.source === undefined ? {} : { source: item.source },
    })
  })
  return {
    surface: { nodes: seqs },
    eventAt(seq) {
      return events.get(seq)
    },
  }
}

function measurementOf(spec) {
  return { nodes: spec.map((item, index) => ({ seq: index * 10, tokens: item.tokens })) }
}

function make(checkpoint = false) {
  return checkpoint ? { kind: 'compact-checkpoint' } : undefined
}

// ---- hasSystemHead ----
{
  const withSystem = makeSession([{ type: 'system/message', tokens: 1000 }])
  check(hasSystemHead(withSystem, 0) === true, '首节点是 system/message 时返回 true')

  const withoutSystem = makeSession([{ type: 'user/message', tokens: 1000 }])
  check(hasSystemHead(withoutSystem, 0) === false, '首节点不是 system 时返回 false')

  check(hasSystemHead({}, 0) === true, '判断不出来时保守返回 true')
}

// ---- indexSurface ----
{
  const session = makeSession([
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
    { type: 'assistant/message', tokens: 500 },
    { type: 'user/message', tokens: 200 },
    { type: 'assistant/message', tokens: 300 },
  ])
  const index = indexSurface(session)
  check(index.firstUserIdx === 1, '首条 user 下标正确')
  check(index.lastUserIdx === 3, '末条 user 下标正确')
  check(index.checkpointIdxs.length === 0, '没有检查点')
}

{
  const session = makeSession([
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
    { type: 'user/message', tokens: 5000, source: make(true) },
    { type: 'assistant/message', tokens: 300 },
  ])
  const index = indexSurface(session)
  check(index.checkpointIdxs.length === 1 && index.checkpointIdxs[0] === 2, '能认出压缩检查点')
  check(index.lastUserIdx === 2, '检查点也算 user/message')
}

// ---- incrementTokens ----
{
  const spec = [
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
    { type: 'assistant/message', tokens: 9000 },
  ]
  check(incrementTokens(measurementOf(spec), []) === 10100, '没有检查点时增量 = 总量')

  const withCheckpoint = makeSession([
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
    { type: 'user/message', tokens: 500, source: make(true) },
    { type: 'assistant/message', tokens: 3000 },
    { type: 'user/message', tokens: 200 },
  ])
  const m = { nodes: [1000, 100, 500, 3000, 200].map((t, i) => ({ seq: i * 10, tokens: t })) }
  check(incrementTokens(m, [2]) === 3200, '增量 = 检查点之后的全部（3000+200）')
  check(withCheckpoint.surface.nodes.length === 5, '假 session 构造正确')
}

// ---- selectCompactSpan：基本形态 ----
{
  const spec = [
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 }, // 原始目标，保护
    { type: 'assistant/message', tokens: 8000 },
    { type: 'user/message', tokens: 100 },
    { type: 'assistant/message', tokens: 6000 },
    { type: 'user/message', tokens: 100 },
    { type: 'assistant/message', tokens: 2000 },
    { type: 'assistant/message', tokens: 1500 },
    { type: 'assistant/message', tokens: 1200 },
    { type: 'assistant/message', tokens: 1000 },
    { type: 'user/message', tokens: 900 },
  ]
  const session = makeSession(spec)
  const span = selectCompactSpan(session, measurementOf(spec), { retainTokens: 0, minIncrementTokens: 0 })

  check(span !== undefined, '能选出区间')
  // startIdx=1（system 之后）；endIdx 应停在 lastUserIdx(10) 之前、且让出最近 5 条
  check(span.start === 10, 'start = system 之后第一条的 seq')
  const lastUserSeq = session.surface.nodes[10]
  check(span.end < lastUserSeq, 'end 在最后一条用户消息之前')
}

// ---- 保护区：最近 5 条一定不压 ----
{
  const spec = [{ type: 'system/message', tokens: 1000 }]
  for (let i = 0; i < 12; i += 1) {
    spec.push({ type: i % 2 === 0 ? 'user/message' : 'assistant/message', tokens: 1000 })
  }
  const session = makeSession(spec)
  const span = selectCompactSpan(session, measurementOf(spec), { retainTokens: 0, minIncrementTokens: 0 })
  const endIdx = session.surface.nodes.indexOf(span.end)
  const protectedCount = session.surface.nodes.length - 1 - endIdx
  check(protectedCount >= BC_STRATEGY_CONSTANTS.PROTECT_RECENT_MESSAGES, '至少保留最近 5 条', String(protectedCount))
}

// ---- 最后一条用户消息绝不进区间 ----
{
  const spec = [
    { type: 'system/message', tokens: 1000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'user/message', tokens: 100 },
  ]
  const session = makeSession(spec)
  const span = selectCompactSpan(session, measurementOf(spec), { retainTokens: 0, minIncrementTokens: 0 })
  const lastUserSeq = session.surface.nodes[4]
  check(span === undefined || span.end < lastUserSeq, '最后一条用户消息不在区间内')
}

// ---- 没有 system 时起点是 0 ----
{
  const spec = [
    { type: 'user/message', tokens: 100 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'assistant/message', tokens: 5000 },
    { type: 'user/message', tokens: 100 },
  ]
  const session = makeSession(spec)
  const span = selectCompactSpan(session, measurementOf(spec), { retainTokens: 0, minIncrementTokens: 0 })
  check(span !== undefined && span.start === session.surface.nodes[0], '没有 system 时从第一条开始')
}

// ---- 增量门：压过之后没新增就不压 ----
{
  const spec = [
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
    { type: 'user/message', tokens: 500, source: make(true) },
    { type: 'assistant/message', tokens: 1000 },
    { type: 'assistant/message', tokens: 1000 },
    { type: 'assistant/message', tokens: 1000 },
    { type: 'assistant/message', tokens: 1000 },
    { type: 'assistant/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
  ]
  const session = makeSession(spec)
  const measurement = measurementOf(spec)
  // 检查点之后只有 4100 个 token
  const strict = selectCompactSpan(session, measurement, { retainTokens: 0, minIncrementTokens: 20000 })
  check(strict === undefined, '增量不足门槛时不压')
  const loose = selectCompactSpan(session, measurement, { retainTokens: 0, minIncrementTokens: 1000 })
  check(loose !== undefined, '增量够门槛时压')
}

// ---- 全是保护区：没得压 ----
{
  const spec = [
    { type: 'system/message', tokens: 1000 },
    { type: 'user/message', tokens: 100 },
    { type: 'assistant/message', tokens: 500 },
  ]
  const session = makeSession(spec)
  const span = selectCompactSpan(session, measurementOf(spec), { retainTokens: 0, minIncrementTokens: 0 })
  check(span === undefined, '全是保护区时返回 undefined')
}

// ---- 结构异常一律 undefined ----
{
  check(selectCompactSpan({}, {}, {}) === undefined, '空 session/measurement 返回 undefined')
  const session = makeSession([{ type: 'user/message', tokens: 100 }])
  check(selectCompactSpan(session, { nodes: [] }, {}) === undefined, 'nodes 为空返回 undefined')
  check(selectCompactSpan(session, { nodes: [{ seq: 0, tokens: 1 }, { seq: 10, tokens: 1 }] }, {}) === undefined, '长度不匹配返回 undefined')
}

// ---- 增量门阈值 ----
{
  check(incrementGateTokens(200000) === 20000, '默认 10% 窗口')
  check(incrementGateTokens(100000) === 10000, '10 万窗口 → 1 万')
  check(incrementGateTokens(0) === 0, '非法窗口返回 0')
  check(incrementGateTokens(200000, 0.05) === 10000, '可覆盖比例')
}

// ---- 旧摘要保护：checkpoint 不能落在选区内部（2026-11-26 新增）----
{
  // 用真实事件结构造数据：source 在 event.data.source
  const mk = (type, tokens, source) => ({
    type,
    tokens,
    data: { content: [{ type: 'text', text: 'x' }], role: 'user', ...(source ? { source } : {}) },
  })
  const spec = [
    mk('system/message', 3000),
    mk('user/message', 200),
    mk('user/message', 500, { kind: 'compact-checkpoint' }),
    mk('assistant/message', 4000),
    mk('assistant/message', 4000),
    mk('assistant/message', 4000),
    mk('assistant/message', 4000),
    mk('assistant/message', 4000),
    mk('user/message', 200),
  ]
  const seqs = spec.map((_, i) => i)
  const session = { surface: { nodes: seqs }, eventAt: (s) => spec[s] }
  const measurement = { nodes: spec.map((s, i) => ({ seq: i, tokens: s.tokens })) }

  const index = indexSurface(session)
  check(index.checkpointIdxs.join(',') === '2', '能识别 data.source.kind 为 compact-checkpoint', index.checkpointIdxs.join(','))

  const span = selectCompactSpan(session, measurement, { retainTokens: 5000, minIncrementTokens: 0 })
  check(span !== undefined, '有旧摘要时仍能选出区间')
  check(span.start > 2, '选区起点在旧摘要之后，不会二次摘要', `start=${span.start}`)
  check(span.isDistill === false, '标记为「纯新增量」而非蒸馏')

  // 没有旧摘要时不该受影响
  const plain = spec.map((s) => ({ ...s, data: { content: [], role: 'user' } }))
  const plainSession = { surface: { nodes: seqs }, eventAt: (s) => plain[s] }
  const plainSpan = selectCompactSpan(plainSession, measurement, { retainTokens: 0, minIncrementTokens: 0 })
  check(plainSpan !== undefined && plainSpan.start <= 2, '没有 checkpoint 时起点仍可以从头开始')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: BC 区间选择策略正确')
