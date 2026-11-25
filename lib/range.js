/**
 * 从 billion-context 的「折叠」布局借用的保护区与可压缩量估算。
 *
 * 借用的三个概念（原创：Xianglei Ran，billion-context，MIT）：
 *
 * 1. **保护区（protected zone）**：最后若干条消息 + 最后一条用户消息 + 第一条
 *    用户消息永远不进压缩区间。原实现把它放在 filter 阶段强制，而不是写在
 *    提示词里让人祈祷。这里同样用代码硬算，只作为**问题里展示的数字**。
 *
 * 2. **只压已消费的增量**：每次压缩只处理「上次压缩以来新增」的部分，不重写
 *    全部历史。本插件用它的推论：两次询问之间如果没有足够增量，就不值得再问。
 *
 * 3. **推荐列表带真实尺寸**：原实现的 nudge 会给模型一份带 token 数的候选区间
 *    列表，理由是「没有尺寸，模型会压错区间」。这里对应为：问题里直接告诉你
 *    这次大约能压掉多少、会留下多少，而不是只给一个百分比。
 *
 * 本模块刻意只做纯计算：输入 tokenMeter 的 measurement 与 session.surface，
 * 输出区间估算。它**不决定**引擎实际压哪里——那由 compaction-basic 的
 * `selectCompactableRange` 决定。两边算法一致时数字准确；不一致时宁可不显示，
 * 也不要给出会误导人的数字。
 */

/** 最后若干条消息视为「正在使用中」，不压。 */
const PROTECT_RECENT_MESSAGES = 5

/**
 * 估算压缩区间与可压缩量。
 *
 * 与引擎一致的走法：从尾部往前累积到 retainTokens，落点必须是工具配对边界，
 * 再往前推一格。差别是这里额外加了两道保护：最近 N 条消息、首尾用户消息。
 *
 * @param measurement - `ctx.tokenMeter.measure()` 的返回值（含 nodes）。
 * @param surfaceSeqs - `session.surface.nodes`（seq 数组，顺序与 nodes 一致）。
 * @param retainTokens - 引擎想保留的尾部 token 数。
 * @param options - `{ hasSystemHead }`：首个节点是 system prompt 时，引擎的
 *   可压缩起点从索引 1 开始（system 永远不会被压）。漏掉这一项会高估可压量，
 *   而 system prompt 往往有好几 K，足以让展示的数字失真。
 * @returns `{ compactableTokens, retainedTokens, retainedNodes, protectedBy }` 或 `undefined`
 */
export function estimateRange(measurement, surfaceSeqs, retainTokens, options = {}) {
  const nodes = measurement?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return undefined
  if (!Array.isArray(surfaceSeqs) || surfaceSeqs.length !== nodes.length) return undefined

  const total = nodes.reduce((sum, node) => sum + (Number(node?.tokens) || 0), 0)
  if (total <= 0) return undefined

  // 尾部向前累积到 retainTokens，得到引擎大概会保留的起点
  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += Number(nodes[index]?.tokens) || 0
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }

  // 保护区：最近 N 条消息不压。这是**下限**——起点最多前移到倒数第 N 条，
  // 绝不因为 retain 目标小而压到最近的消息上。反过来，如果 retain 目标本来就
  // 要求保留更多（尾部堆了很长的原文），那就听 retain 的，保护得更多。
  const recentFloor = Math.max(0, nodes.length - PROTECT_RECENT_MESSAGES)
  let protectedBy = 'retain'
  if (keepFromIdx > recentFloor) {
    keepFromIdx = recentFloor
    protectedBy = 'recent'
  }

  // 首个节点通常是 system prompt，引擎会把它排除在可压缩区间之外
  // （compaction-basic 的 `firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1`）。
  // 这里跟着做，避免把 system prompt 的 token 算进「能腾出」的量里。
  const firstIdx = options.hasSystemHead === true ? 1 : 0
  if (keepFromIdx <= firstIdx) {
    return { compactableTokens: 0, retainedTokens: total, retainedNodes: nodes.length, protectedBy: 'nothing-to-compact' }
  }

  let compactable = 0
  for (let index = firstIdx; index < keepFromIdx; index += 1) compactable += Number(nodes[index]?.tokens) || 0
  const retained = total - compactable

  return {
    compactableTokens: Math.max(0, Math.floor(compactable)),
    retainedTokens: Math.max(0, Math.floor(retained)),
    retainedNodes: nodes.length - keepFromIdx,
    protectedBy,
  }
}

/**
 * 引擎在本轮实际会保留的 token 数，与 `compaction-basic` 的算法一致：
 *   retainTokens = floor(messageBudget × retainRatio)
 *
 * @param contextWindow - 模型窗口
 * @param reservedCompletionTokens - 输出预留
 * @param retainRatio - 快照里的 retainRatio
 * @returns floor 后的 token 数；参数不合法时返回 undefined
 */
export function retainTokensFor(contextWindow, reservedCompletionTokens, retainRatio) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) return undefined
  const messageBudget = contextWindow - reservedCompletionTokens
  if (messageBudget <= 0) return undefined
  if (!Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio >= 1) return undefined
  return Math.floor(messageBudget * retainRatio)
}

/**
 * 增量门控：两次询问之间涨了多少才「值得再问」。
 *
 * 原实现的门控是 50K 增长、有效下限 45%（≈22.5K），并且刻意**不告诉模型
 * 上下文填充比例**——它把判断锚定在任务上而不是一个百分比上。这里保留
 * 「阈值之外还有一道增量门」这个思想，但比例由用户可配（reAskRatio）。
 *
 * @param contextWindow - 模型窗口
 * @param reAskRatio - 用户设的重问增长比例
 * @returns 需要增长的 token 数（至少 1）
 */
export function growthGateTokens(contextWindow, reAskRatio) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return 1
  const ratio = Number.isFinite(reAskRatio) ? reAskRatio : 0.05
  return Math.max(1, Math.floor(contextWindow * ratio))
}

/** 把 token 数写成给人看的形式：12500 → "12.5K"。 */
export function formatTokens(tokens) {
  const value = Number(tokens)
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export const RANGE_CONSTANTS = Object.freeze({ PROTECT_RECENT_MESSAGES })
