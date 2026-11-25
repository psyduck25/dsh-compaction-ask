/**
 * 摘要质量分级与可量化的质量检测。
 *
 * ## 这是什么
 *
 * BC 有一件事做得很对：**摘要不是越长越好，也不是越短越好，而是「该留的留下」**。
 * 但它并没有「摘要质量等级」这种开关（源码里 `summaryQuality` / `qualityLevel` /
 * `compressionLevel` 的出现次数都是 0）。它的 tier-1/2/3 是**压缩层级**（压摘要
 * 本身），不是质量档位。
 *
 * 所以这里做的是 BC 没做的那一层：**把质量判据做成可选的档位，并且能在压缩后
 * 自动核对「产物是否符合该档位」**。不靠感觉，靠可数的指标。
 *
 * ## 质量怎么量
 *
 * ROUGE 那类指标需要参考摘要，这里没有参考，所以走**可检查属性**（deterministic
 * contract checks），这也正是 DSH 自己能做、且不额外烧 token 的部分：
 *
 * | 指标 | 含义 | 为什么重要 |
 * | --- | --- | --- |
 * | `anchors` | 原文里的文件路径/行号/错误串/版本号，有多少进了摘要 | BC 的头号 KEEP 规则就是这些；丢了就没法 grep 回去 |
 * | `decisions` | 「因为/所以/because/rationale」类决策理由是否保留 | 没有理由的决策等于没有决策 |
 * | `openObjectives` | 未完成事项是否还在 | 丢了就是任务失踪 |
 * | `structure` | 是否按要求的小节输出 | 结构塌了说明模型没遵守模板 |
 * | `density` | 每千字承载的可检索信息量 | 太稀说明废话多 |
 *
 * 这些都能从「被压掉的原文」和「产出的摘要」双方直接算，不需要第三次模型调用。
 *
 * ## 档位如何真的改变摘要
 *
 * 档位不是装饰：它改变**发给模型的指令**（`lib/philosophy.js` 的判据选择）与
 * **压缩后的验收门槛**（本文件的 `scoreSummary`）。低档位允许更激进的压缩，
 * 高档位要求更完整的保留 —— 两者都体现在提示词和验收里，所以是真实的改变。
 */

/**
 * 质量档位。
 *
 * ## 数值怎么来的（不是拍的）
 *
 * 用同一份 30,000 字真实对话，让三个独立 agent 按三档规则各写一份摘要，
 * 实测结果：
 *
 * | 档位 | 摘要字数 | 占原文 | 锚点覆盖率 | 理由标记 | 信息密度 |
 * | --- | --- | --- | --- | --- | --- |
 * | lean | 2,762 | 9.2% | 30% | 0 | 10.9 |
 * | balanced | 4,639 | 15.5% | 33% | 0 | 8.8 |
 * | strict | 8,427 | 28.1% | 37% | 3 | 7.7 |
 *
 * 三个结论：
 *   1. **档位真的改变摘要**：字数 3 倍差、锚点率单调上升、理由标记只有 strict 出现；
 *   2. 预算按实测值上浮约 20% 作为门槛（留出模型波动余量）；
 *   3. 锚点率的**绝对值**受原文性质影响很大（这份样本 54 个锚点里大部分是
 *      探索阶段的命令行路径，本就不该保留），所以门槛设得比实测均值略低，
 *      只用来**挡住明显劣化**，不用来追求高分。
 *
 * 密度随档位下降是正常的：高档位摘要更长，单位字数承载的锚点自然摊薄。
 */
export const QUALITY_TIERS = Object.freeze({
  // 关闭：不注入任何判据、也不做验收 —— 等价于 DSH 随包行为。
  // 保留这一档是因为设置页需要一个「我不想动摘要」的明确选项：只有三个
  // 「都带判据」的档位时，用户没有退路，只能挑一个自己其实不想要的规则集。
  off: {
    label: '关闭',
    description: '不注入任何判据，用 DSH 随包指令压缩，也不做压缩后验收。',
    minAnchorRatio: 0,
    minDensity: 0,
    requireStructure: false,
    requireOpenObjectives: false,
    requireRationale: false,
    budget: 1,
  },
  lean: {
    label: '精简',
    description: '只留骨架：目标、关键结论、下一步。适合短会话或上下文特别紧张时。',
    minAnchorRatio: 0.25,
    minDensity: 0.8,
    requireStructure: false,
    requireOpenObjectives: false,
    requireRationale: false,
    // 实测 9.2%，门槛给 11%
    budget: 0.11,
  },
  balanced: {
    label: '平衡（推荐）',
    description: '默认档：保留锚点、决策理由、未完成事项，同时控制体积。',
    minAnchorRatio: 0.3,
    minDensity: 1.2,
    requireStructure: true,
    requireOpenObjectives: true,
    requireRationale: true,
    // 实测 15.5%，门槛给 19%
    budget: 0.19,
  },
  strict: {
    label: '严格',
    description: '近乎逐条对应：锚点覆盖率最高、要求理由与未完成事项齐全。适合长任务、需要反复回溯的场景。',
    minAnchorRatio: 0.33,
    minDensity: 1.6,
    requireStructure: true,
    requireOpenObjectives: true,
    requireRationale: true,
    // 实测 28.1%，门槛给 34%
    budget: 0.34,
  },
})

/** 档位顺序，用于「只能往严调不能往松调」这类提示。`off` 在最松端。 */
export const QUALITY_ORDER = Object.freeze(['off', 'lean', 'balanced', 'strict'])

/**
 * 从文本里抽「可检索锚点」。
 *
 * 优先抽那些**丢了就找不回来**的东西（BC 的 KEEP VERBATIM 规则）：
 * 带行号的文件路径、错误串、版本号、明确的数值阈值。
 *
 * @param text - 原文或摘要
 * @returns 去重后的锚点数组（小写）
 */
export function extractAnchors(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()

  // 文件路径 + 行号：lib/hooks.ts:347 / src/a.ts:12-18
  for (const match of text.matchAll(/[A-Za-z0-9_\-./\\]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|py|rs|go|java|c|cpp|h|css|html|sh|ps1)(?::\d+(?:-\d+)?)?/g)) {
    found.add(match[0].toLowerCase())
  }
  // 错误码 / 全部大写的常量
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{4,}\b/g)) {
    found.add(match[0].toLowerCase())
  }
  // 版本号
  for (const match of text.matchAll(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/g)) {
    found.add(match[0].toLowerCase())
  }
  // 反引号里的标识符（函数名、配置键）
  for (const match of text.matchAll(/`([A-Za-z_][\w.:-]{2,60})`/g)) {
    found.add(match[1].toLowerCase())
  }

  return [...found]
}

/**
 * 把「原文」分成散文与工具输出两部分，只在散文上算锚点。
 *
 * ## 为什么要分
 *
 * 拿真实会话试过：一份 2MB 的原文里，光 `ls -R` 风格的目录列举就贡献了
 * 484 个 `.js` 路径。把它们算成「摘要应当保留的锚点」会让任何摘要都判不合格，
 * 而这个指标本身也就失去意义。
 *
 * BC 的判据写得很清楚：工具输出属于 **DROP**（"verbose logs once you have
 * captured the error line"），散文与错误串属于 **KEEP VERBATIM**。
 * 所以锚点召回只在散文上量，才和真正的质量诉求对齐。
 *
 * @param events - 事件数组（每条含 `type` 与 `data`）
 * @returns `{ prose, tool }` 两段文本
 */
export function splitSource(events) {
  const prose = []
  const tool = []

  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.type
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') continue
    const data = event.data ?? {}
    const message = data.message ?? data
    const content = Array.isArray(message?.content) ? message.content : []

    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        // 用户/助手的自然语言正文算散文；tool/result 的文本算工具输出
        if (type === 'tool/result') tool.push(block.text)
        else prose.push(block.text)
      } else if (block.type === 'tool-call') {
        // 工具调用参数（命令、路径）算散文侧：它记录了「做过什么」
        prose.push(`${block.name ?? ''} ${JSON.stringify(block.arguments ?? '')}`)
      } else if (block.type === 'tool-result') {
        tool.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''))
      }
    }
  }

  return { prose: prose.join('\n'), tool: tool.join('\n') }
}

/**
 * 判断文本里有没有「决策 + 理由」。
 *
 * 中英双模式：BC 的判据是 `"chose X over Y because Z"` —— because 是关键。
 *
 * @param text - 待检测文本
 * @returns 命中的理由标记数
 */
export function countRationaleMarkers(text) {
  if (typeof text !== 'string' || text === '') return 0
  const patterns = [
    /\bbecause\b/gi,
    /\bsince\b/gi,
    /\brather than\b/gi,
    /\bso that\b/gi,
    /因为/g,
    /所以/g,
    /理由是/g,
    /而不是/g,
    /原因/g,
    /否则/g,
  ]
  let total = 0
  for (const pattern of patterns) total += (text.match(pattern) ?? []).length
  return total
}

/**
 * 判断有没有「未完成事项」段。
 *
 * @param text - 摘要文本
 * @returns 是否含 Open objectives / 未完成 / 待办 一类标记
 */
export function hasOpenObjectives(text) {
  if (typeof text !== 'string') return false
  return /Open objectives|未完成|待办|TODO|下一步|pending/i.test(text)
}

/**
 * 判断是否按 DSH 要求的 Markdown 小节输出。
 *
 * 只要求出现至少两个标准小节标题，避免把「结构」判得太死 ——
 * 不同模型的小节命名会有出入。
 *
 * @param text - 摘要文本
 * @returns 命中的小节数
 */
export function countSections(text) {
  if (typeof text !== 'string') return 0
  const required = [
    'Primary Request and Intent',
    'Key Technical Concepts',
    'Files and Code',
    'Errors and Fixes',
    'Pending Jobs',
    'Current Work',
    'Next Step',
    'Critical Context',
  ]
  let hits = 0
  for (const name of required) {
    if (text.includes(name)) hits += 1
  }
  return hits
}

/**
 * 给一份摘要打分，并对照档位判断是否合格。
 *
 * @param summaryText - 产出的摘要
 * @param sourceText - 被压缩的原文（用来算锚点覆盖率）
 * @param tier - 质量档位名
 * @returns `{ tier, score, passed, metrics, failures }`
 */
export function scoreSummary(summaryText, sourceText, tier = 'balanced') {
  const spec = QUALITY_TIERS[tier] ?? QUALITY_TIERS.balanced
  const summary = typeof summaryText === 'string' ? summaryText : ''
  const source = typeof sourceText === 'string' ? sourceText : ''

  const sourceAnchors = extractAnchors(source)
  const summaryAnchors = extractAnchors(summary)
  const summarySet = new Set(summaryAnchors)

  let kept = 0
  for (const anchor of sourceAnchors) {
    if (summarySet.has(anchor)) kept += 1
  }
  const anchorRatio = sourceAnchors.length === 0 ? 1 : kept / sourceAnchors.length

  const rationale = countRationaleMarkers(summary)
  const sections = countSections(summary)
  const openObjectives = hasOpenObjectives(summary)

  // 密度：每千字摘要里有多少可检索锚点 + 理由标记。
  // 用「千字」而不是「每 token」，因为这里只有文本，不重新计 token。
  const perThousand = summary.length === 0 ? 0 : (summaryAnchors.length + rationale) / (summary.length / 1000)

  const budgetChars = Math.max(200, Math.floor(source.length * spec.budget))
  const withinBudget = summary.length <= budgetChars || source.length === 0

  const failures = []
  if (anchorRatio < spec.minAnchorRatio) {
    failures.push(`锚点覆盖率 ${(anchorRatio * 100).toFixed(0)}% 低于「${spec.label}」要求的 ${(spec.minAnchorRatio * 100).toFixed(0)}%`)
  }
  if (perThousand < spec.minDensity) {
    failures.push(`信息密度 ${perThousand.toFixed(2)} 低于要求的 ${spec.minDensity}`)
  }
  if (spec.requireStructure && sections < 2) {
    failures.push(`缺少结构化小节（命中 ${sections} 个，至少 2 个）`)
  }
  if (spec.requireOpenObjectives && !openObjectives) {
    failures.push('缺少未完成事项/下一步说明')
  }
  if (spec.requireRationale && rationale === 0) {
    failures.push('没有任何决策理由（because/因为/而不是…）')
  }
  if (!withinBudget) {
    failures.push(`摘要 ${summary.length} 字超出「${spec.label}」预算 ${budgetChars} 字`)
  }

  return {
    tier,
    label: spec.label,
    passed: failures.length === 0,
    failures,
    metrics: {
      anchorRatio: Number(anchorRatio.toFixed(3)),
      anchorsKept: kept,
      anchorsTotal: sourceAnchors.length,
      rationale,
      sections,
      openObjectives,
      density: Number(perThousand.toFixed(3)),
      summaryChars: summary.length,
      budgetChars,
    },
  }
}

/**
 * 档位改变时，是否应该提示用户提高质量。
 *
 * 任务 2 的联动：`retainRatio` 越低 → 保留原文越少 → 越依赖摘要，
 * 此时应当建议提高质量档位。
 *
 * @param retainRatio - 新的 retainRatio
 * @param quality - 当前质量档位
 * @returns 建议文案，或 `undefined`
 */
export function suggestQualityForRetain(retainRatio, quality) {
  const index = QUALITY_ORDER.indexOf(quality)
  if (!Number.isFinite(retainRatio)) return undefined
  // `off` 是用户明确说「不要判据」，不再劝他提高质量 —— 那是在反复质疑
  // 一个已经做出的决定，只会让红色提示变成噪音。
  if (quality === 'off') return undefined
  // 保留比例 0.16 是允许的最低值，此时摘要承担的历史最多。
  // 但「平衡」已经能扛住，所以只在用户选了更低的「精简」时才提示 ——
  // 默认配置天天报红会让所有警告都失去意义。
  if (retainRatio <= 0.16 && index < QUALITY_ORDER.indexOf('balanced')) {
    return '保留比例已是下限 16%，摘要要独自承担几乎全部历史；建议把摘要质量至少调到「平衡」'
  }
  if (retainRatio <= 0.24 && index < QUALITY_ORDER.indexOf('balanced')) {
    return '保留比例较低（≤24%），建议把摘要质量至少调到「平衡」'
  }
  return undefined
}

/**
 * 生成「建议同时改什么」的实时提示。
 *
 * 这是任务 5 选的方案：**红色小字提示**，而不是在参数上加一段静态推荐。
 * 理由：静态推荐是死的，用户改完参数就过期了；实时提示能跟着当前草稿算，
 * 每次都指向「你现在这个组合还差什么」。
 *
 * 返回的是数组，每项 `{ level, text }`：`level` 为 `warn` 时界面用红色。
 *
 * @param draft - 当前的设置草稿（已归一化的数字，不是表单字符串）
 * @returns 提示数组
 */
export function advisorHints(draft) {
  const hints = []
  if (draft === undefined || draft === null) return hints

  const retain = Number(draft.retainRatio)
  const ask = Number(draft.askRatio)
  const quality = String(draft.quality ?? 'balanced')
  const strategy = String(draft.compactStrategy ?? 'stock')
  const gate = Number(draft.incrementGateTokens)

  // 1. 保留比例与摘要质量的搭配
  const suggest = suggestQualityForRetain(retain, quality)
  if (suggest !== undefined) hints.push({ level: 'warn', text: suggest })

  // 2. 保留比例与询问阈值的硬约束
  if (Number.isFinite(retain) && Number.isFinite(ask)) {
    const floor = Math.round((retain + 0.06) * 1000) / 1000
    if (ask < floor - 1e-9) {
      hints.push({
        level: 'warn',
        text: `询问阈值 ${Math.round(ask * 100)}% 低于当前保留比例允许的下限 ${Math.round(floor * 100)}%，保存时会自动提到 ${Math.round(floor * 100)}%`,
      })
    }
  }

  // 3. BC 策略下的增量门控
  if (strategy === 'bc' && Number.isFinite(gate) && gate < 10000) {
    hints.push({ level: 'warn', text: '区间策略为 BC 时，增量门控低于 10000 会导致压缩过于频繁，建议 ≥ 20000' })
  }
  if (strategy === 'bc' && quality === 'lean') {
    hints.push({ level: 'warn', text: 'BC 策略会压掉大段历史，配合「精简」质量容易丢细节，建议至少「平衡」' })
  }

  // 4. 严格质量要求足够的保留窗口
  if (quality === 'strict' && Number.isFinite(retain) && retain < 0.2) {
    hints.push({ level: 'warn', text: '「严格」质量需要保留比例 ≥ 20%，否则摘要没有足够原文支撑' })
  }

  return hints
}

/**
 * 策略切换时应该自动带上的参数。
 *
 * 任务 4：「选择策略的时候直接要去改变参数，同时限制两种策略的最低值」。
 *
 * 每个策略有自己的合理区间 —— 切换时不是只改一个字符串，而是把整套参数
 * 调到该策略的推荐值，同时保证不突破硬下限。
 *
 * @param strategy - `stock` 或 `bc`
 * @param current - 当前设置
 * @returns 调整后的设置（不写盘，由调用方保存）
 */
export function applyStrategyDefaults(strategy, current = {}) {
  const base = { ...current }

  if (strategy === 'bc') {
    // BC：只压增量 → 需要增量门控；保留量可以低一些，但不得低于 0.16
    base.compactStrategy = 'bc'
    base.incrementGateTokens = Math.max(20000, Number(base.incrementGateTokens) || 0)
    base.retainRatio = Math.max(0.16, Number(base.retainRatio) || 0.16)
    // BC 会压掉大段历史，质量不应低于平衡。但 `off` 是用户显式选择「不要判据」，
    // 切换策略不该把它悄悄打开 —— 那等于违背一个明确的意愿。所以只抬 lean。
    if (base.quality === 'lean') {
      base.quality = 'balanced'
    }
  } else {
    // stock：尾部保留，不依赖增量门控
    base.compactStrategy = 'stock'
    base.incrementGateTokens = 20000
    base.retainRatio = Math.max(0.16, Number(base.retainRatio) || 0.16)
  }

  // 两者共同：询问阈值不得低于保留比例推算的下限
  const floor = minAskRatioForLocal(base.retainRatio)
  base.askRatio = Math.max(Number(base.askRatio) || floor, floor)

  return base
}

/** 与 settings.js 的 `minAskRatioFor` 同公式，避免循环依赖。 */
function minAskRatioForLocal(retainRatio) {
  const base = Number.isFinite(retainRatio) ? Math.max(0.16, retainRatio) : 0.16
  return Math.min(0.99, Math.round((base + 0.06) * 1000) / 1000)
}

export const QUALITY_CONSTANTS = Object.freeze({ QUALITY_ORDER })
