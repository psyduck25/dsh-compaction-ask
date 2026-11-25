/**
 * 摘要提示词增强：给 compaction 那次 LLM 调用追加 billion-context 的压缩判据。
 *
 * ## 为什么不用继承 `BasicCompactionEngine`
 *
 * 第一版是 `extends BasicCompactionEngine` 再覆盖 `summarize`。行不通，原因是
 * 依赖解析：`@deepseek-ai/*` 是 asar 内置包，只在 DSH 自己的模块解析环境里
 * 可见，profile 的插件目录解析不到它 —— 实测 `require.resolve` 直接抛错。
 * 一个 `ERR_MODULE_NOT_FOUND` 会让**整个预设激活失败**，代价太大。
 *
 * ## 实际做法：只认 `purpose` 字段
 *
 * `compaction-basic` 调 `ctx.llm.stream(options)` 时带着
 *   `purpose: "compaction"`
 * （源码里写死的）。`ctx.llm` 每次都经 cordis 的 `internal/get` 瀑布解析，
 * 在这里返回一个把 `stream()` 包过的代理即可：只拦 `purpose === 'compaction'`
 * 的调用，其它一律原样透传。
 *
 * 好处：
 * - 不 import 任何 `@deepseek-ai/*`，没有解析风险；
 * - 不改 `compaction-basic` 那一行，引擎仍是随包原版，升级不用跟；
 * - 判定条件只有「这次调用是不是摘要」，逻辑面积极小。
 *
 * 这正是 billion-context 自己接入 DSH 的方式（它监听 `internal/config`），
 * 属于 cordis 的官方扩展点，不是野路子。
 *
 * ## 借用内容
 *
 * KEEP VERBATIM / DROP / PRIORITY 三段判据，以及「摘要记录的是过去」这个
 * 框架约束，来自 billion-context（MIT）。随包指令只说要哪些小节，不说必须
 * 逐字保留什么、什么可以丢、预算紧张时先保什么 —— 后者才是命中率的来源。
 */

import { qualityRules } from './quality-rules.js'

/** 随包摘要指令的固定开头。 */
export const INSTRUCTION_PREFIX = 'You are now acting as a compaction engine'

/**
 * 随包指令里的结构特征。
 *
 * 光凭开头不够：用户可能粘贴或提到这句话，那种消息不该被加上几千字判据。
 * 再要求同一块文本里出现模板小节，才算认出来。
 */
const INSTRUCTION_SIGNATURES = Object.freeze([
  '## Primary Request and Intent',
  '## Current Work',
  'Output EXACTLY the Markdown structure below',
])

/** 判据已注入过的标记，避免重复追加。 */
export const MARKER = 'ADDITIONAL RULES (these override any conflicting instruction above)'

/** 只有这个 purpose 的调用会被增强。 */
export const COMPACTION_PURPOSE = 'compaction'

/**
 * 旧版静态判据，保留导出只为兼容已有的引用点。
 *
 * 真正生效的判据由 `lib/quality-rules.js` 按质量档位生成 ——
 * 静态常量无法表达「档位不同则规则不同」，所以这里改成了函数调用。
 *
 * @deprecated 用 `qualityRules(tier)`
 */
export const PHILOSOPHY = qualityRules('balanced')

/**
 * 这段文本是不是随包的摘要指令。
 *
 * 双重判定：以固定句开头 **且** 含模板特征小节。只判开头会把用户「引用」
 * 这句话的消息也增强掉；只判小节则可能命中用户粘贴的摘要格式。
 *
 * @param text - 待判定的文本块
 * @returns 是随包指令时返回 true
 */
export function isCompactionInstruction(text) {
  if (typeof text !== 'string' || !text.startsWith(INSTRUCTION_PREFIX)) return false
  return INSTRUCTION_SIGNATURES.some((signature) => text.includes(signature))
}

/**
 * 给一次 `llm.stream` 的 options 注入判据。
 *
 * 只动那条摘要指令（双重识别），真实用户消息、工具历史一律不碰。
 * 认不出来就原样返回 —— 宁可不增强，也不能改坏别人的提示词。
 *
 * @param options - 将要传给 `ctx.llm.stream` 的调用参数
 * @param purpose - 本次调用的 purpose；只有 `compaction` 会被处理
 * @param tier - 质量档位；决定用哪套判据（`lib/quality-rules.js`）
 * @returns 可能被增强的 options（不改原对象；无需改动时返回原对象本身）
 */
export function enhanceStreamOptions(options, purpose, tier = 'balanced') {
  if (purpose !== COMPACTION_PURPOSE) return options
  if (options === null || typeof options !== 'object') return options
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return options

  // 每次调用现取判据：档位可以在运行中改（设置页保存后下一次摘要即生效），
  // 不能把它固化进模块常量。
  const rules = qualityRules(tier)
  // `off` 档的判据是空串 —— 原样透传，一点都不改。这条短路必须在下面
  // 的 map 之前：否则会把指令文本 trim 一遍，虽然内容等价，但没有理由动它。
  if (rules === '') return options

  let changed = false
  const next = messages.map((message) => {
    if (message === null || typeof message !== 'object') return message
    if (message.role !== 'user' || !Array.isArray(message.content)) return message

    let touched = false
    const content = message.content.map((block) => {
      if (block === null || typeof block !== 'object') return block
      if (block.type !== 'text' || typeof block.text !== 'string') return block
      if (!isCompactionInstruction(block.text)) return block
      // 换成当前档位的判据：先剥掉旧判据（档位改过时），再追加新的
      const base = stripInjectedRules(block.text)
      touched = true
      return { ...block, text: `${base}\n\n${rules}` }
    })
    if (!touched) return message
    changed = true
    return { ...message, content }
  })

  return changed ? { ...options, messages: next } : options
}

/**
 * 去掉之前注入过的判据。
 *
 * 档位从 balanced 改到 strict 时，如果不先剥掉旧文本，模型会看到两份
 * 互相矛盾的 KEEP/DROP 规则 —— 那比不注入更糟。
 *
 * @param text - 可能已含判据的指令文本
 * @returns 只剩随包原始内容的文本
 */
export function stripInjectedRules(text) {
  if (typeof text !== 'string') return text
  const index = text.indexOf(MARKER)
  return index < 0 ? text : text.slice(0, index).trimEnd()
}

/**
 * 把 llm 服务包一层：只有 `stream()` 被过一道，其余成员原样转发。
 *
 * 用原型链继承原对象，所以 `resolveModelInfo`、`imageRequestPricing`、
 * `fileRequestText` 等任何现存/将来新增的成员都不用在这里列一遍。
 *
 * @param llm - 真实的 llm 服务
 * @param tierProvider - 返回当前质量档位的函数；不传则固定 balanced
 * @returns 代理对象；不是可用服务时原样返回
 */
export function wrapLlm(llm, tierProvider) {
  if (llm === null || typeof llm !== 'object') return llm
  if (typeof llm.stream !== 'function') return llm
  const tierOf = typeof tierProvider === 'function' ? tierProvider : () => 'balanced'
  const proxy = Object.create(llm)
  Object.defineProperty(proxy, 'stream', {
    value(options, ...rest) {
      const purpose = options !== null && typeof options === 'object' ? options.purpose : undefined
      let tier = 'balanced'
      try {
        tier = tierOf()
      } catch {
        // 读档位失败就用默认档，绝不因此让摘要调用失败
      }
      return llm.stream(enhanceStreamOptions(options, purpose, tier), ...rest)
    },
    configurable: true,
  })
  return proxy
}
