/**
 * 从会话日志里还原被压缩掉的历史。
 *
 * ## 为什么这能成立
 *
 * DSH 的压缩是 `surfaceOp: replace` —— 只在**模型可见的 surface** 上把那一段
 * 影子掉，原始事件仍然完整留在 `session.log` 里。`@deepseek-ai/dsh-session`
 * 的注释原话：
 *
 *   "The model-visible surface deliberately shadows replaced ranges, so it is
 *    the wrong source for a human transcript — a landed replacement would erase
 *    conversation the user already saw. Append-origin events are that
 *    transcript's durable source material."
 *
 * 所以「压缩」在 DSH 里**本来就是可逆的**，只是没有给模型提供读回来的工具。
 * billion-context 的 `decompress` 做的正是这件事：把摘要对应的原文重新取回来。
 *
 * ## 和 BC 的差别
 *
 * BC 是自己维护块谱系（blockId → effectiveMessageIds），所以能精确地
 * 「解压某个块」。DSH 没有块概念，但它有更好的东西：**完整的日志**。
 * 所以这里按 `compaction/summary` 事件反查 `shadowedSeqs` / `shadowedRange`，
 * 直接读日志原文 —— 保真度是 100%，不像 BC 那样受摘要磨损。
 *
 * ## 只读，不改会话
 *
 * 还原出来的内容只作为工具返回值给模型看，不写回 surface。要写回去等于
 * 撤销压缩，那会破坏 `compaction/summary` 的记账，不是这个模块该做的事。
 */

/** 单次还原的字符上限，防止把 2MB 原文一次性倒给模型。 */
const MAX_RECOVER_CHARS = 200_000

/**
 * 列出这个会话的所有压缩记录。
 *
 * @param session - DSH session
 * @returns `[{ compactionId, start, end, seqCount, tokens, summaryChars, at }]`
 */
export function listCompactions(session) {
  const log = snapshotLog(session)
  if (log === undefined) return []

  const summaries = log.filter((event) => event?.type === 'compaction/summary')
  return summaries.map((event, index) => {
    const data = event.data ?? {}
    const range = data.shadowedRange ?? {}
    const summary = Array.isArray(data.summary) ? data.summary : []
    return {
      id: index + 1,
      compactionId: data.compactionId,
      start: Number(range.start),
      end: Number(range.end),
      seqCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
      tokens: Number(data.shadowedTokenCount) || 0,
      summaryChars: summaryText(summary).length,
      provider: data.provider,
      model: data.model,
    }
  })
}

/**
 * 还原某次压缩的原文。
 *
 * @param session - DSH session
 * @param selector - `{ index }`（第几次压缩，1 起）或 `{ compactionId }` 或 `{ seq }`（取包含该 seq 的那次）
 * @returns `{ ok, header, text, truncated, totalChars }` 或 `{ ok:false, error }`
 */
export function recoverCompaction(session, selector = {}) {
  const log = snapshotLog(session)
  if (log === undefined) return { ok: false, error: '读不到会话日志' }

  const bySeq = new Map()
  for (const event of log) {
    if (event !== null && typeof event === 'object' && typeof event.seq === 'number') bySeq.set(event.seq, event)
  }

  const summaries = log.filter((event) => event?.type === 'compaction/summary')
  if (summaries.length === 0) return { ok: false, error: '这个会话还没有被压缩过，没有可还原的内容' }

  const target = pickCompaction(summaries, selector)
  if (target === undefined) {
    return {
      ok: false,
      error: `找不到指定的压缩记录。这个会话共有 ${summaries.length} 次压缩，用 index 1–${summaries.length} 指定。`,
    }
  }

  const seqs = Array.isArray(target.data?.shadowedSeqs) ? target.data.shadowedSeqs : []
  const parts = []
  let totalChars = 0
  let truncated = false

  for (const seq of seqs) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const text = renderEvent(event)
    if (text === '') continue
    totalChars += text.length
    if (parts.join('\n').length + text.length > MAX_RECOVER_CHARS) {
      truncated = true
      break
    }
    parts.push(text)
  }

  if (parts.length === 0) return { ok: false, error: '这次压缩的原文在日志里已经找不到了' }

  const range = target.data?.shadowedRange ?? {}
  const summary = summaryText(Array.isArray(target.data?.summary) ? target.data.summary : [])
  const header = [
    `还原了第 ${summaries.indexOf(target) + 1} 次压缩的原文：seq ${range.start}–${range.end}，共 ${seqs.length} 条事件。`,
    `这次压缩把约 ${target.data?.shadowedTokenCount ?? '?'} tokens 换成了 ${summary.length} 字的摘要。`,
    truncated ? `内容超过 ${MAX_RECOVER_CHARS} 字符，只返回了前 ${parts.length} 条（共 ${totalChars} 字符）。` : '',
  ].filter((line) => line !== '').join('\n')

  return { ok: true, header, text: parts.join('\n\n'), truncated, eventCount: parts.length, totalChars }
}

/**
 * 在压缩记录里按关键词搜索原文。
 *
 * BC 的 `search_context` 对应物：不还原全部，只找出相关的几条。
 *
 * @param session - DSH session
 * @param query - 关键词（大小写不敏感的子串匹配）
 * @param limit - 最多返回多少条
 * @returns `{ ok, matches }` 或 `{ ok:false, error }`
 */
export function searchHistory(session, query, limit = 20) {
  const keyword = typeof query === 'string' ? query.trim() : ''
  if (keyword === '') return { ok: false, error: '搜索关键词不能为空' }

  const log = snapshotLog(session)
  if (log === undefined) return { ok: false, error: '读不到会话日志' }

  const lower = keyword.toLowerCase()
  const summaries = log.filter((event) => event?.type === 'compaction/summary')
  const bySeq = new Map()
  for (const event of log) {
    if (event !== null && typeof event === 'object' && typeof event.seq === 'number') bySeq.set(event.seq, event)
  }

  const matches = []
  for (let index = 0; index < summaries.length; index += 1) {
    const seqs = Array.isArray(summaries[index].data?.shadowedSeqs) ? summaries[index].data.shadowedSeqs : []
    for (const seq of seqs) {
      const event = bySeq.get(seq)
      if (event === undefined) continue
      const text = renderEvent(event)
      if (!text.toLowerCase().includes(lower)) continue
      matches.push({
        compaction: index + 1,
        seq,
        type: event.type,
        excerpt: excerptAround(text, lower),
      })
      if (matches.length >= limit) return { ok: true, matches, truncated: true }
    }
  }

  return { ok: true, matches, truncated: false }
}

/**
 * 取出可用于检索的日志快照。
 *
 * 优先 `snapshotEvents()`（官方接口），退回 `log` 数组。两者都是完整日志，
 * 不是 surface —— 这正是能还原原文的前提。
 *
 * @param session - DSH session
 * @returns 事件数组，或 undefined
 */
function snapshotLog(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const all = session.snapshotEvents(0, session.seq ?? Number.MAX_SAFE_INTEGER)
      if (Array.isArray(all) && all.length > 0) return all
    }
  } catch {
    // 落到下面的 log 直读
  }
  const log = session?.log
  if (Array.isArray(log)) return log
  return undefined
}

/**
 * 挑选要还原的那次压缩。
 *
 * @param summaries - compaction/summary 事件数组
 * @param selector - `{ index }` / `{ compactionId }` / `{ seq }`
 * @returns 命中的事件，或 undefined
 */
function pickCompaction(summaries, selector) {
  // 显式给了 index 就必须命中：越界时报错，而不是悄悄退回「最近一次」——
  // 那会让调用方以为拿到的是第 99 次，实际是最后一次，拿到错的内容还不自知。
  if (selector.index !== undefined && selector.index !== null) {
    if (!Number.isInteger(selector.index) || selector.index < 1 || selector.index > summaries.length) {
      return undefined
    }
    return summaries[selector.index - 1]
  }
  if (typeof selector.compactionId === 'string' && selector.compactionId !== '') {
    return summaries.find((event) => event.data?.compactionId === selector.compactionId)
  }
  if (Number.isFinite(selector.seq)) {
    return summaries.find((event) => {
      const range = event.data?.shadowedRange ?? {}
      return selector.seq >= Number(range.start) && selector.seq <= Number(range.end)
    })
  }
  // 完全没指定时默认还原最近一次
  return summaries[summaries.length - 1]
}

/** 把一条事件渲染成可读文本。 */
function renderEvent(event) {
  const data = event?.data
  if (data === undefined || data === null) return ''

  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const message = data.message ?? data
    const content = Array.isArray(message?.content) ? message.content : []
    const texts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (block.type === 'tool-call') texts.push(`[调用 ${block.name ?? '工具'}] ${truncate(JSON.stringify(block.arguments ?? ''), 400)}`)
      else if (block.type === 'tool-result') texts.push(`[结果] ${truncate(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''), 800)}`)
    }
    const role = event.type === 'user/message' ? '用户' : '助手'
    return texts.length === 0 ? '' : `【${role} · seq ${event.seq}】\n${texts.join('\n')}`
  }

  if (typeof data === 'string') return truncate(data, 2000)
  return truncate(JSON.stringify(data), 2000)
}

/** 取一块摘要事件的纯文本。 */
function summaryText(blocks) {
  return blocks
    .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** 截断字符串并标注。 */
function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…[截断，原长 ${value.length}]`
}

/** 取关键词前后一小段，给搜索结果用。 */
function excerptAround(text, lowerKeyword) {
  const index = text.toLowerCase().indexOf(lowerKeyword)
  if (index < 0) return truncate(text, 200)
  const start = Math.max(0, index - 120)
  const end = Math.min(text.length, index + 200)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

export const RECOVER_CONSTANTS = Object.freeze({ MAX_RECOVER_CHARS })
