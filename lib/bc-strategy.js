/**
 * BC 式压缩区间选择。
 *
 * ## 和 DSH 原生策略的根本差别
 *
 * DSH 的 `compaction-basic` 用**尾部保留**策略：从最后一条消息往前累加到
 * `retainRatio × 预算`，把剩下的全部压掉。它压多少取决于「保留多少」，
 * 不取决于「新增了多少」。
 *
 * billion-context 的策略相反：**只压已消费的增量**。每次压缩只处理「上次
 * 压缩以来新增、且已经用完」的部分，最近还在用的原文一律不动。结果是：
 *
 * - 单次压缩能压掉的量远大于尾部策略（因为它吃的是整段旧历史，不是一小截）；
 * - 压缩次数因此显著减少（历史总长 ∝ 调用次数 → 压缩次数 ∝ 新增量）；
 * - 每段内容一生只被折一次，不会被反复重写。
 *
 * ## 本模块负责什么
 *
 * 只算「该压哪一段」（start/end 两个 seq）。真正写事件、保证协议正确的是
 * `compaction-basic` 的 `compactRegion()` —— 那里有配对平衡、事件写入、
 * 稳定性和并发锁的全部逻辑，重写一遍风险远大于收益。
 *
 * ## 保护区（借自 BC）
 *
 * 三条硬规则，任何情况下都不压：
 * 1. system prompt（首个节点）；
 * 2. 最后一条用户消息（当前意图）；
 * 3. 最近 N 条消息（正在使用中）。
 *
 * 另外保留第一条用户消息（原始目标）—— BC 把它列为软保护，这里按硬保护处理，
 * 因为 DSH 的压缩是「一条摘要顶替一整段」，原始目标一旦丢掉就找不回来了。
 */

const PROTECT_RECENT_MESSAGES = 5

/** BC 的增量门控下限：增量不足这个量就不值得压。 */
const MIN_INCREMENT_RATIO = 0.1

/**
 * 找出 surface 上的关键节点。
 *
 * @param session - DSH session
 * @returns `{ firstUserIdx, lastUserIdx, checkpointIdxs }`（都是 surface 下标）
 */
export function indexSurface(session) {
  const seqs = session?.surface?.nodes
  if (!Array.isArray(seqs)) return { seqs: [], firstUserIdx: -1, lastUserIdx: -1, checkpointIdxs: [] }

  let firstUserIdx = -1
  let lastUserIdx = -1
  const checkpointIdxs = []

  for (let index = 0; index < seqs.length; index += 1) {
    let event
    try {
      event = typeof session.eventAt === 'function' ? session.eventAt(seqs[index]) : undefined
    } catch {
      event = undefined
    }
    if (event === undefined || event === null) continue

    if (event.type === 'user/message') {
      if (firstUserIdx < 0) firstUserIdx = index
      lastUserIdx = index
      // 压缩检查点也是 user/message，靠 source.kind 区分
      if (event.data?.source?.kind === 'compact-checkpoint') checkpointIdxs.push(index)
    }
  }

  return { seqs, firstUserIdx, lastUserIdx, checkpointIdxs }
}

/**
 * 上次压缩之后新增了多少 token。
 *
 * BC 的增速门控就是拿这个量和阈值比：不够就不压，避免「压了等于没压」。
 *
 * @param measurement - `tokenMeter.measure()` 的结果
 * @param checkpointIdxs - 检查点在 surface 上的下标（可能有多个）
 * @returns 增量 token 数；从未压过时等于总量
 */
export function incrementTokens(measurement, checkpointIdxs) {
  const nodes = measurement?.nodes
  if (!Array.isArray(nodes)) return 0
  const total = nodes.reduce((sum, node) => sum + (Number(node?.tokens) || 0), 0)
  if (!Array.isArray(checkpointIdxs) || checkpointIdxs.length === 0) return total

  // 用最后一个检查点作为分界：它之后的内容才算「新增」。
  // 检查点自身代表被压掉的历史，不算新增。
  const last = checkpointIdxs[checkpointIdxs.length - 1]
  let after = 0
  for (let index = last + 1; index < nodes.length; index += 1) after += Number(nodes[index]?.tokens) || 0
  return after
}

/**
 * 首节点是不是 system prompt。
 *
 * 与 `compaction-basic` 的 `systemHead()` 同义：是 system 时它不参与压缩。
 * 判断不出来时保守当「是」——少压一条只是效率损失，压掉 system 会破坏会话。
 *
 * @param session - DSH session
 * @param firstSeq - 首节点 seq
 * @returns 首节点是 system/message 时返回 true
 */
export function hasSystemHead(session, firstSeq) {
  try {
    const event = typeof session.eventAt === 'function' ? session.eventAt(firstSeq) : undefined
    if (event === undefined || event === null) return true
    return event.type === 'system/message'
  } catch {
    return true
  }
}

/**
 * 选出一段要压缩的区间。
 *
 * 策略（全部来自 BC）：
 * 1. 起点永远是第一个可压节点（跳过 system prompt）；
 * 2. 终点从尾部往前退，直到让出「保护区」——最近 N 条、最后一条用户消息、
 *    以及 `retainTokens` 要求的保留量；
 * 3. 区间必须至少包含一条工具调用/结果的完整配对（交给引擎校验）；
 * 4. 若区间内不含任何可压内容（例如全是 system + 保护区），返回 `undefined`。
 *
 * 与 DSH 原生策略的差别集中在第 2 步：原生只退到 `retainTokens` 为止，
 * 这里还要额外退过保护区和最后一条用户消息，**且起点不随保留量移动** ——
 * 也就是说它一次压掉的是整段旧历史，而不是紧挨着保护区的一小截。
 *
 * @param session - DSH session
 * @param measurement - `tokenMeter.measure()` 的结果
 * @param options - `{ retainTokens, minIncrementTokens }`
 * @returns `{ start, end, spanTokens, incrementTokens }` 或 `undefined`
 */
export function selectCompactSpan(session, measurement, options = {}) {
  const nodes = measurement?.nodes
  const seqs = session?.surface?.nodes
  if (!Array.isArray(nodes) || !Array.isArray(seqs) || nodes.length !== seqs.length || nodes.length === 0) return undefined

  const retainTokens = Number.isFinite(options.retainTokens) ? Math.max(0, options.retainTokens) : 0
  const { firstUserIdx, lastUserIdx, checkpointIdxs } = indexSurface(session)

  // 起点：system prompt 之后第一条。必须真检测，不能假定「首节点一定是 system」——
  // 没有 system 的会话（子 agent、被裁剪过的会话）会因此少压一条。
  let startIdx = hasSystemHead(session, seqs[0]) ? 1 : 0
  if (startIdx >= nodes.length) return undefined

  // ★ 关键：旧摘要（compact-checkpoint）必须是**选区起点**，不能落进区间内部。
  //
  // 为什么：DSH 的压缩是「一段连续区间换成一条新摘要」。如果旧的 checkpoint
  // 落在区间里，它就会被再摘要一次 —— 那是**二次摘要**，每一轮都会再损失
  // 一部分信息。实测本会话第 2 次压缩就把第 1 次的 15,267 字摘要又压了一遍，
  // 信息留存率只剩 38%（与 BC 论文报的 ρ≈0.4–0.6 吻合）。
  //
  // 把起点定在最后一个 checkpoint 之后，等价于 BC 的「只压已消费的增量」：
  // 归档的摘要永远原样保留，只压它后面新长出来的历史。
  //
  // 例外：如果 checkpoint 就是首节点（只压过一次、什么都还没压），
  // 那么从它之后开始没有意义 —— 此时正常处理，让它参与本次压缩。
  const lastCheckpointIdx = checkpointIdxs.length > 0 ? Math.max(...checkpointIdxs) : -1
  if (lastCheckpointIdx >= startIdx) startIdx = lastCheckpointIdx + 1
  if (startIdx >= nodes.length) return undefined

  // 终点：先按 retainTokens 从尾部退
  let endIdx = nodes.length - 1
  let accumulated = 0
  while (endIdx >= startIdx && accumulated < retainTokens) {
    accumulated += Number(nodes[endIdx]?.tokens) || 0
    endIdx -= 1
  }

  // 再按保护区退：最近 N 条
  const recentFloor = nodes.length - PROTECT_RECENT_MESSAGES - 1
  if (endIdx > recentFloor) endIdx = recentFloor

  // 最后一条用户消息必须留在外面（当前意图不能被压掉）
  if (lastUserIdx >= 0 && endIdx >= lastUserIdx && lastUserIdx > startIdx) endIdx = lastUserIdx - 1

  // 原始目标（第一条用户消息）也不压 —— 只有它确实落在区间内部时才收缩
  if (firstUserIdx > startIdx && endIdx >= firstUserIdx) endIdx = firstUserIdx - 1

  if (endIdx < startIdx) return undefined

  let spanTokens = 0
  for (let index = startIdx; index <= endIdx; index += 1) spanTokens += Number(nodes[index]?.tokens) || 0
  if (spanTokens <= 0) return undefined

  const increment = incrementTokens(measurement, checkpointIdxs)
  const minIncrement = Number.isFinite(options.minIncrementTokens) ? options.minIncrementTokens : 0
  // 增量门：只压「上次压缩之后新增」的部分。已经压过且没多少新增时不动。
  if (checkpointIdxs.length > 0 && increment < minIncrement) return undefined

  return {
    start: seqs[startIdx],
    end: seqs[endIdx],
    spanTokens,
    incrementTokens: increment,
    // 起点已经在所有 checkpoint 之后，所以正常情况下区间内不会含旧摘要。
    // 保留这个字段是为了告诉调用方「这次压的纯粹是新增量」。
    isDistill: false,
  }
}

/**
 * 增量门控阈值。
 *
 * BC 用「窗口的 10%」作为「值得压一次」的下限（它自己是 50K/有效 22.5K，
 * 换算到 200K 窗口约 10%）。这里保持同一比例，允许调用方覆盖。
 *
 * @param contextWindow - 模型窗口
 * @param ratio - 覆盖比例
 * @returns token 阈值
 */
export function incrementGateTokens(contextWindow, ratio = MIN_INCREMENT_RATIO) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return 0
  const effective = Number.isFinite(ratio) && ratio > 0 ? ratio : MIN_INCREMENT_RATIO
  return Math.floor(contextWindow * effective)
}

export const BC_STRATEGY_CONSTANTS = Object.freeze({ PROTECT_RECENT_MESSAGES, MIN_INCREMENT_RATIO })
