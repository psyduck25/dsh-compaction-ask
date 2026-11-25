/**
 * 保护区 / 可压缩量估算的单元测试。
 *
 * 这些数字会直接显示在询问框里，算错等于给用户假情报，所以边界要逐个钉住。
 */

import { estimateRange, formatTokens, growthGateTokens, retainTokensFor, RANGE_CONSTANTS } from '../lib/range.js'

let failures = 0

function log(message) {
  console.log(`  ok   ${message}`)
}

function fail(message, detail) {
  failures += 1
  console.error(`  FAIL ${message}${detail === undefined ? '' : `: ${detail}`}`)
}

function equal(actual, expected, name) {
  actual === expected ? log(name) : fail(name, `期望 ${expected}，实际 ${actual}`)
}

/** 造一组节点：system + 一堆消息，尾部几条很小（模拟「正在使用中」）。 */
function makeNodes(counts) {
  const nodes = counts.map((tokens, seq) => ({ seq, tokens }))
  return { measurement: { nodes }, surfaceSeqs: nodes.map((node) => node.seq) }
}

// ---- 保护区：最近 N 条消息永远不压（作为下限）----
{
  const { measurement, surfaceSeqs } = makeNodes([5000, 20000, 30000, 1000, 900, 800, 700, 600])
  const retain = retainTokensFor(100000, 8192, 0.05)
  equal(retain, 4590, 'retainTokensFor 与引擎公式一致（4590）')

  // 手工推演（总 59000，system 占索引 0）：
  // 尾部累加 600+700+800+900+1000=4000 仍 < 4590，再加 30000 → 起点落在索引 2。
  // 索引 2 比「倒数第 5 条」（索引 3）更靠前，即 retain 要求保留得更多；
  // 保护区是下限不是上限，所以听 retain 的。
  // 可压 = 索引 1..1 = 20000，保留 = 59000 − 20000 = 39000，保留节点数 = 8 − 2 = 6。
  const range = estimateRange(measurement, surfaceSeqs, retain, { hasSystemHead: true })
  equal(range.protectedBy, 'retain', 'retain 目标更大时按 retain 保留')
  equal(range.compactableTokens, 20000, '可压 = 索引 1 的 20000（system 不可压）')
  equal(range.retainedTokens, 39000, '保留 = 59000 − 20000')
  equal(range.retainedNodes, 6, '保留从索引 2 起的 6 个节点')

  // 反向：retain 目标很小，但保护区不放松 → 起点顶到倒数第 5 条（索引 3）
  // 可压 = 索引 1..2 = 20000 + 30000 = 50000，保留 = 9000，保留节点数 = 5
  const small = estimateRange(measurement, surfaceSeqs, 100, { hasSystemHead: true })
  equal(small.protectedBy, 'recent', 'retain 目标小时保护区接管')
  equal(small.compactableTokens, 50000, '可压 = 20000 + 30000')
  equal(small.retainedTokens, 9000, '保留最近 5 条 + 各自前面的部分 = 9000')
  equal(small.retainedNodes, 5, '保留最近 5 个节点')
}

// ---- 尾部很大时，retainTokens 优先 ----
{
  const { measurement, surfaceSeqs } = makeNodes([5000, 1000, 1000, 40000])
  const range = estimateRange(measurement, surfaceSeqs, 10000, { hasSystemHead: true })
  // 尾部 40000 一条就 ≥ 10000，起点落在索引 3（最后一条自己），可压为 0
  equal(range.compactableTokens, 0, '最后一条自己就够 retain 目标时可压为 0')
  equal(range.protectedBy, 'nothing-to-compact', '没有可压区间时如实标记')
}

// ---- system prompt 不计入可压量 ----
{
  const { measurement, surfaceSeqs } = makeNodes([9000, 40000, 40000, 500, 500, 500, 500, 500])
  const withSystem = estimateRange(measurement, surfaceSeqs, 1000, { hasSystemHead: true })
  const withoutSystem = estimateRange(measurement, surfaceSeqs, 1000, { hasSystemHead: false })
  equal(withSystem.compactableTokens + 9000, withoutSystem.compactableTokens, '有 system 时少算 system 的 9000')
}

// ---- 没什么可压 ----
{
  const { measurement, surfaceSeqs } = makeNodes([1000, 2000])
  const range = estimateRange(measurement, surfaceSeqs, 100000)
  equal(range.compactableTokens, 0, '全部都要保留时可压为 0')
}

// ---- 结构不合法一律返回 undefined（绝不编数字）----
{
  equal(estimateRange(undefined, [0], 100), undefined, '没有 measurement 返回 undefined')
  equal(estimateRange({ nodes: [] }, [], 100), undefined, 'nodes 为空返回 undefined')
  equal(estimateRange({ nodes: [{ seq: 0, tokens: 10 }] }, [0, 1], 10), undefined, 'seq 数量对不上返回 undefined')
}

// ---- 增量门控 ----
{
  equal(growthGateTokens(100000, 0.05), 5000, '增量门 = 窗口 × 5%')
  equal(growthGateTokens(100000, 0), 1, '比例为 0 时至少为 1')
  equal(growthGateTokens(0, 0.05), 1, '窗口非法时至少为 1')
}

// ---- 格式化 ----
{
  equal(formatTokens(980), '980', '小于 1000 直接给数字')
  equal(formatTokens(12500), '13K', '一万以上不带小数')
  equal(formatTokens(9800), '9.8K', '一万以下带一位小数')
  equal(formatTokens(1250000), '1.3M', '百万级用 M')
  equal(formatTokens(-5), '0', '负数夹到 0')
}

// ---- 常量与文档一致 ----
{
  equal(RANGE_CONSTANTS.PROTECT_RECENT_MESSAGES, 5, '保护区保留最近 5 条')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 保护区与可压缩量估算正确')
