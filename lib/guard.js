/**
 * compaction-ask 守护行：上下文接近上限时先问人，再决定要不要压缩。
 *
 * 挂在 agent 预设的 `compaction` 组里，紧挨 `@deepseek-ai/dsh-compaction-basic`
 * （那一行被本插件的快照设成 `auto: false`）。每个 `agent/pre-step` 用
 * `ctx.tokenMeter` 量一次压力；到达阈值就问人，只有回答「现在压缩」才调用
 * `ctx.compaction.compactIfNeeded`。
 *
 * 「折叠」相关机制借自 billion-context（原创：Xianglei Ran，MIT）：
 * 保护区、只压已消费增量、推荐列表带真实尺寸（见 range.js 与 README 的致谢）。
 *
 * 约束：
 * - 只依赖包内模块（node 内置 + 本包的 settings/range），不引入任何第三方包，
 *   这样插件升级或 DSH 升级都不会因为依赖解析失败而炸。
 * - 绝不打断这一轮：任何失败路径都放行到 `next()`。
 * - 参数从 `$DSH_HOME/compaction-ask/settings.json` 读，设置页保存后下一次
 *   `agent/pre-step` 就生效，不需要重启。
 */

import { DEFAULTS, readSettingsCached, resolveDshHome } from './settings.js'
import { estimateRange, formatTokens, growthGateTokens, retainTokensFor } from './range.js'
import { selectCompactSpan } from './bc-strategy.js'
import { splitSource } from './quality.js'
import { verifySummary } from './summarizer.js'

export const name = 'compaction-ask'

const COMPACT = '现在压缩'
const SKIP = '暂不压缩'
const MUTE = '本会话不再询问'

export function apply(ctx, rawConfig) {
  const rowConfig = isRecord(rawConfig) ? rawConfig : {}
  const home = typeof rowConfig.home === 'string' && rowConfig.home !== '' ? rowConfig.home : resolveDshHome()
  const states = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const config = resolveConfig(home, rowConfig)
      await guard(ctx, config, payload, states)
    } catch (error) {
      warn(ctx, `compaction-ask: skipped a question after an unexpected failure: ${describe(error)}`)
    }
    return typeof next === 'function' ? next() : undefined
  })
}

/** 文件里的值压过行配置，行配置压过默认值。 */
function resolveConfig(home, rowConfig) {
  const file = readSettingsCached(home)
  return { ...DEFAULTS, ...rowConfig, ...file }
}

async function guard(ctx, config, payload, states) {
  const agent = payload?.agent
  const signal = payload?.signal
  if (agent === undefined || agent === null) return
  if (signal?.aborted) return
  const session = agent.session
  if (session === undefined || typeof session.requestHeader !== 'function') return

  const meter = ctx.get('tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') return

  const point = await askPoint(ctx, config, session, signal)
  if (point === undefined) return

  const measurement = meter.measure(session)
  const total = Number.isFinite(measurement?.totalTokens) ? measurement.totalTokens : 0

  const state = states.get(agent) ?? { askedAt: 0, muted: false }
  states.set(agent, state)
  if (total < point.thresholdTokens) {
    if (state.askedAt !== 0) state.askedAt = 0
    return
  }
  if (state.muted) return

  const growth = growthGateTokens(point.contextWindow, config.reAskRatio)
  if (state.askedAt > 0 && total < state.askedAt + growth) return

  // 「只压已消费的增量」的推论：可压缩量太小就不值得再问一次。
  // 原实现把 50K 门控下限乘 0.45 作为有效下限；这里用同一思路的简化版：
  // 可压缩量低于重问增长门槛的一半时，问了也是白问（引擎压不出多少东西）。
  const surfaceSeqs = session.surface?.nodes
  const range = estimateRange(measurement, surfaceSeqs, point.retainTokens, { hasSystemHead: hasSystemHead(session) })
  if (range !== undefined && range.compactableTokens > 0 && range.compactableTokens < Math.floor(growth / 2)) {
    return
  }

  state.askedAt = total
  const decision = await askHuman(ctx, config, agent, signal, point, total, range)
  if (decision === 'mute') {
    state.muted = true
    return
  }
  if (decision !== 'compact') return

  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactIfNeeded !== 'function') {
    warn(ctx, 'compaction-ask: compaction service is unavailable, nothing was compacted')
    return
  }

  // ---- 选区间：走 BC 策略还是随包策略 ----
  // BC 策略：自己选「整段旧历史」，再调 compactRegion 执行；
  // 随包策略：交给 compactIfNeeded，它按 retainRatio 从尾部留一截。
  const span = config.compactStrategy === 'bc'
    ? selectCompactSpan(session, measurement, {
        retainTokens: point.retainTokens,
        minIncrementTokens: config.incrementGateTokens,
      })
    : undefined

  if (config.compactStrategy === 'bc' && span === undefined) {
    warn(ctx, 'compaction-ask: BC 策略没有找到可压区间（增量不足或全在保护区），本次不压缩')
    return
  }

  const result = span === undefined
    ? await compaction.compactIfNeeded(agent, 'pressure', signal)
    : await compactBySpan(compaction, span, agent, signal)

  if (result === null || result === undefined) {
    warn(ctx, 'compaction-ask: the engine declined; its thresholdRatio must stay below the ask ratio')
    return
  }
  state.askedAt = 0

  // 压缩已成功落盘，现在按当前档位验收产物。
  // 只警告、不撤销：回滚历史再压一次的代价远大于「摘要略差」，而且用户
  // 已经被告知压缩发生了，悄悄撤销会让 surface 与他的认知对不上。
  verifyAfterCompaction(ctx, session, config)
}

/**
 * 压缩后按质量档位验收摘要。
 *
 * 档位如果不影响验收，那它就只是装饰 —— 三档判据在提示词里生效、
 * 却没人检查产物是否符合，用户永远不知道「严格」到底有没有被遵守。
 *
 * `quality === 'off'` 时直接跳过：那一档的语义就是「不要判据、也不验收」。
 *
 * @param ctx - cordis context
 * @param session - 刚被压缩的会话
 * @param config - 当前设置
 */
function verifyAfterCompaction(ctx, session, config) {
  if (config.quality === 'off') return
  try {
    const log = sessionLog(session)
    if (log === undefined) return

    // 找最后一条 compaction/summary：这次压缩刚写的，必然在尾部
    let summaryEvent
    for (let index = log.length - 1; index >= 0; index -= 1) {
      if (log[index]?.type === 'compaction/summary') {
        summaryEvent = log[index]
        break
      }
    }
    if (summaryEvent === undefined) return

    const data = summaryEvent.data ?? {}
    const blocks = Array.isArray(data.summary) ? data.summary : []
    const summaryText = blocks
      .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
    if (summaryText === '') return

    // 被压掉的原文：优先用 shadowedSeqs 精确取，取不到就退回区间
    const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
    const events = []
    for (const seq of seqs) {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
      if (event !== undefined && event !== null) events.push(event)
    }
    if (events.length === 0) return

    // 锚点只在散文上量（见 quality.js 的 splitSource）：工具输出里的
    // 目录列举会把任何摘要都判成不合格
    const sourceText = splitSource(events).prose
    if (sourceText === '') return

    const verdict = verifySummary(summaryText, sourceText, config.quality)
    if (verdict.passed === true) {
      info(ctx, `compaction-ask: 摘要通过「${verdict.label}」档验收（锚点 ${Math.round(verdict.metrics.anchorRatio * 100)}%，${verdict.metrics.summaryChars} 字）`)
      return
    }
    warn(ctx, `compaction-ask: 摘要未达到「${verdict.label}」档：${verdict.failures.join('；')}`)
  } catch (error) {
    // 验收失败绝不能让压缩结果作废
    warn(ctx, `compaction-ask: summary verification was skipped (${describe(error)})`)
  }
}

/** 取会话日志；优先快照接口，退回原始 log。 */
function sessionLog(session) {
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents(0, session.seq)
      if (Array.isArray(snapshot) && snapshot.length > 0) return snapshot
    }
  } catch {
    // 退回 session.log
  }
  return Array.isArray(session.log) ? session.log : undefined
}

async function askPoint(ctx, config, session, signal) {
  const header = session.requestHeader()
  const route = header?.config
  if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') return
  if (route.provider.length === 0 || route.model.length === 0) return

  const requestContext = typeof session.requestContext === 'function' ? session.requestContext() : undefined
  let contextWindow = requestContext?.contextWindow
  let reserved = route.maxTokens
  if (!isPositiveInteger(contextWindow) || !isNonNegativeInteger(reserved)) {
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return
    const info = await llm.resolveModelInfo(route.provider, route.model, signal)
    if (info === undefined || info === null) return
    if (!isPositiveInteger(contextWindow)) contextWindow = info.context?.contextWindow
    if (!isNonNegativeInteger(reserved)) reserved = info.defaultMaxTokens
  }
  if (!isPositiveInteger(contextWindow)) return
  if (!isNonNegativeInteger(reserved)) reserved = 0

  const messageBudget = contextWindow - reserved
  if (messageBudget <= 0) return
  const pressureBudget = messageBudget - config.headroomTokens
  if (pressureBudget <= 0) return
  const thresholdTokens = Math.floor(Math.min(contextWindow * config.askRatio, pressureBudget))
  if (!isPositiveInteger(thresholdTokens)) return
  const retainTokens = retainTokensFor(contextWindow, reserved, config.retainRatio)
  return { contextWindow, thresholdTokens, retainTokens }
}

async function askHuman(ctx, config, agent, outerSignal, point, total, range) {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined || typeof userQuestions.ask !== 'function') return
  if (outerSignal?.aborted) return

  const controller = new AbortController()
  const forwardAbort = () => controller.abort(outerSignal?.reason)
  outerSignal?.addEventListener?.('abort', forwardAbort, { once: true })
  const seconds = Number.isFinite(config.timeoutSeconds) && config.timeoutSeconds > 0 ? config.timeoutSeconds : 0
  const timer = seconds > 0 ? setTimeout(() => controller.abort(new Error('compaction-ask: question timed out')), Math.floor(seconds * 1000)) : undefined

  const percent = Math.round((total / point.contextWindow) * 100)
  const usedK = Math.round(total / 1000)
  const windowK = Math.round(point.contextWindow / 1000)

  // 「推荐列表带真实尺寸」：告诉你这次大概能压掉多少、会留下多少，
  // 而不是只丢一个百分比让你自己猜。数字算不出来时（引擎行为对不上）
  // 就退回只说比例，绝不编一个数。
  const detail = []
  if (range !== undefined && range.compactableTokens > 0) {
    detail.push(`现在压大约能腾出 ${formatTokens(range.compactableTokens)}，保留最近 ${formatTokens(range.retainedTokens)} 左右的原文`)
  }
  const detailText = detail.length > 0 ? `\n${detail.join('；')}。` : ''

  try {
    const result = await userQuestions.ask({
      questions: [
        {
          id: 'compact-context',
          header: '上下文接近上限',
          question: `本次会话的上下文已用到约 ${percent}%（约 ${usedK}K / ${windowK}K tokens）。要现在压缩较早的历史吗？${detailText}`,
          options: [
            { label: COMPACT, description: '把较早的历史总结成一条摘要后继续本轮请求；会多一次模型调用。正在使用的最近几条消息不会被压。' },
            { label: SKIP, description: '先不压缩。这不是失败——调试或重构到一半时拒绝是合理的，上下文再增长一段后会再问。' },
            { label: MUTE, description: '本次会话不再询问；需要时你可以手动输入 /compact。' },
          ],
        },
      ],
      agent,
      signal: controller.signal,
    })
    return interpret(result)
  } catch (error) {
    warn(ctx, `compaction-ask: question was not answered (${describe(error)}); continuing without compacting`)
    return
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outerSignal?.removeEventListener?.('abort', forwardAbort)
  }
}

/**
 * 首个 surface 节点是不是 system prompt。
 *
 * 与 `compaction-basic` 的 `systemHead(...)` 判断同一个意思：是的话引擎的
 * 可压缩区间从索引 1 开始，system 本身永远不进摘要。判断不出来时保守地当作
 * 「有 system」——宁可少报可压量，也不要给出偏大的数字骗人点「现在压缩」。
 */
function hasSystemHead(session) {
  try {
    const first = session.surface?.nodes?.[0]
    if (first === undefined) return false
    const event = typeof session.eventAt === 'function' ? session.eventAt(first) : undefined
    if (event === undefined || event === null) return true
    return event.type === 'system/message'
  } catch {
    return true
  }
}

/**
 * 按 BC 选出的区间执行压缩。
 *
 * 调用 `compaction-basic` 的 `compactRegion(start, end, agent, signal)`：
 * 它负责校验区间、保证工具配对平衡、写 `compaction/start` / `compaction/summary`
 * 事件、替换 surface、以及并发锁。这些都不重写 —— 重写一遍风险远大于收益。
 *
 * 区间选择才是策略差异所在，那一部分在上面的 `selectCompactSpan`。
 *
 * @param compaction - `ctx.compaction` 实例
 * @param span - `selectCompactSpan` 的返回值
 * @param agent - 当前 agent
 * @param signal - 取消信号
 * @returns 压缩结果，或 `undefined`（引擎没有这个方法时）
 */
async function compactBySpan(compaction, span, agent, signal) {
  if (typeof compaction.compactRegion !== 'function') return undefined
  return compaction.compactRegion(span.start, span.end, agent, signal)
}

function interpret(result) {
  const answers = Array.isArray(result?.answers) ? result.answers : []
  const first = isRecord(answers[0]) ? answers[0] : {}
  const selected = Array.isArray(first.selected) ? first.selected.filter((label) => typeof label === 'string') : []
  const custom = typeof first.custom === 'string' ? first.custom.trim() : ''
  if (selected.includes(MUTE) || /不再/.test(custom)) return 'mute'
  if (selected.includes(COMPACT)) return 'compact'
  if (selected.includes(SKIP)) return 'skip'
  if (custom.length > 0) return /压缩/.test(custom) && !/[不暂别]/.test(custom) ? 'compact' : 'skip'
  return 'skip'
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // 记日志本身绝不能再抛
  }
}

function info(ctx, message) {
  try {
    ctx.logger?.info?.(message)
  } catch {
    // 同上
  }
}