/**
 * 插件的可调参数：读写 `$DSH_HOME/compaction-ask/settings.json`。
 *
 * 为什么不放 Loader Config：
 * 1. 守护行住在 standard 预设的 `config.plugins` 里，预设配置只能整份替换，
 *    改一行的参数就要重写整份快照；
 * 2. 参数是用户点界面改的运行时偏好，写进 `cordis.patch.yml` 会把每次保存
 *    都变成一次配置编辑，还要走配置层生效流程。
 *
 * 结构（只存用户字段）：
 *   { askRatio, reAskRatio, timeoutSeconds }
 * `headroomTokens` 不属于用户偏好：它与预设快照的 compaction-basic 行必须对齐，
 * 所以由插件内置、不接受文件覆盖（早先版本把它写进了文件，旧值会悄悄改变触发点）。
 * 读取时会忽略残留值并在设置页提示。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 未写过设置文件时使用的值。 */
export const DEFAULTS = Object.freeze({
  askRatio: 0.6,
  reAskRatio: 0.05,
  timeoutSeconds: 300,
  headroomTokens: 16384,
  // 必须与本文件 ENGINE.retainRatio 一致：compaction-basic 就是按这个比例
  // 决定保留多少尾部原文的。守护行只用它来估算「这次能压掉多少」，
  // 写错只会让问题里的数字不准，不会影响压缩本身。
  //
  // 0.16 是**允许的最低值**（任务要求：不允许更低）。理由见 ENGINE.retainRatio。
  retainRatio: 0.16,
  // 摘要质量档位：lean / balanced / strict。见 lib/quality.js 与 quality-rules.js。
  quality: 'balanced',
  // 摘要默认用随包指令。改成 philosophy 需要重新生成快照并重启。
  summarizerPolicy: 'stock',
  // 区间选择策略：`stock` = 随包尾部保留；`bc` = 只压已消费增量（billion-context 式）。
  // 影响的是「压哪一段」，不需要重新生成快照，改完下一次询问即生效。
  compactStrategy: 'stock',
  // BC 增量门控：上次压缩后新增不足这个量就不压。
  incrementGateTokens: 20000,
})

/**
 * 保留比例允许的最低值。
 *
 * 任务要求：`retainRatio` 不得低于 DSH 自己的默认值 0.16。
 * 低于它意味着压缩后逐字保留的原文比 DSH 原厂设置还少 ——
 * 那会让摘要承担全部历史信息，风险大于收益。
 */
export const MIN_RETAIN_RATIO = 0.16

/**
 * 保留比例为最低值（0.16）时，询问阈值允许的最低值 —— 22%。
 *
 * 这个字常量只是**兜底默认**，真实下限永远由 `minAskRatioFor(retainRatio)`
 * 按当前保留比例动态算（见下面）。
 */
export const MIN_ASK_RATIO_WITH_RETAIN = 0.22

/**
 * 与 `retainRatio` 绑定的询问阈值下限。
 *
 * ## 为什么保留比例 0.16 ⇒ 询问阈值最低 22%
 *
 * `compaction-basic` 有一条加载期硬校验：
 *
 *   retainRatio 必须 **严格小于** thresholdRatio
 *
 * 违反它不是「压缩失败」，而是**整个预设校验失败、所有会话不可用**。
 * 而 `thresholdRatio`（引擎放行门槛）又要低于询问阈值，才能在
 * 「你点了现在压缩」时真的放行。链条是三层：
 *
 *   retainRatio (0.16) < thresholdRatio (0.18) < 询问阈值 (0.22)
 *
 * 所以公式是 `retainRatio + 0.06`：中间 0.02 给加载校验、末尾 0.04 给
 * 「引擎放行」与取整余量。0.16 时正好得到 22%，与任务要求一致。
 *
 * @param retainRatio - 当前保留比例
 * @returns 允许的最低询问阈值
 */
export function minAskRatioFor(retainRatio) {
  if (!Number.isFinite(retainRatio)) return MIN_ASK_RATIO_WITH_RETAIN
  const value = Math.max(MIN_RETAIN_RATIO, retainRatio) + 0.06
  return Math.min(0.99, Math.round(value * 1000) / 1000)
}

/**
 * 保留比例对应的引擎放行门槛。
 *
 * 必须严格大于 `retainRatio`（加载校验），所以固定 +0.02。
 *
 * @param retainRatio - 保留比例
 * @returns 应写入快照的 `thresholdRatio`
 */
export function thresholdRatioFor(retainRatio) {
  const base = Number.isFinite(retainRatio) ? Math.max(MIN_RETAIN_RATIO, retainRatio) : MIN_RETAIN_RATIO
  return Math.min(0.97, Math.round((base + 0.02) * 1000) / 1000)
}

/**
 * 「摘要质量」对保留比例的反向约束。
 *
 * 质量越高，摘要越长、越需要足够大的原文窗口来支撑；如果保留比例压到最低，
 * 摘要要独自承担全部历史，再要求「严格」质量是自相矛盾的。所以高档位
 * 会把保留比例的下限抬高 —— 这就是任务里「质量调到最高时也要让窗口/保留
 * 比例有个下限」的落地。
 *
 * @param quality - 质量档位
 * @returns 该档位要求的保留比例下限
 */
export function minRetainRatioFor(quality) {
  if (quality === 'strict') return 0.2
  if (quality === 'balanced') return MIN_RETAIN_RATIO
  return MIN_RETAIN_RATIO
}

/**
 * 预设快照里引擎侧那几个值。
 *
 * `thresholdRatio` / `retainRatio` 是**引擎的放行门槛**，不是自动压缩阈值：
 * `auto: false` 时它不触发任何压缩，只决定用户点了「现在压缩」之后
 * `compactIfNeeded(agent,'pressure')` 肯不肯真的执行。
 *
 * 为什么要一起压低：`compaction-basic` 有两道硬校验
 *   1. 加载时 `retainRatio` 必须**小于** `thresholdRatio`（否则直接抛错，
 *      整个预设激活失败）；
 *   2. 执行时 `measurement.totalTokens < thresholdTokens` 就返回 `null`，
 *      也就是「问了但你点了压缩，引擎却不干」。
 * 所以询问阈值能低到多少，完全由这两个值决定。保留比例取 DSH 默认的 0.16
 * 作为下限，于是 thresholdRatio 取 0.18、询问阈值最低 0.22（见 minAskRatioFor）。
 *
 * 代价：压缩后保留的原样尾部为 16%（与 DSH 默认一致）。
 *
 * `headroomTokens` 与守护行保持一致：阈值公式是
 *   threshold = min(窗口 × 比例, 窗口 − 输出预留 − headroom)
 * 取 16384 后，32K 窗口的模型也能真正按设置的比例触发（65536 时
 * 窗口 ≤64K 根本触发不了，≤128K 会提前触发）。
 *
 * 注意下限：窗口 − 输出预留 − headroom 必须 > 0，否则引擎抛
 * TargetPressureConfigError。16K 窗口的模型会被 16384 卡死（连询问都不发生），
 * 这是 headroom 的固有代价，不是可调项——真遇到 16K 模型需要把
 * headroomTokens 再降到 4096 左右。
 */
export const ENGINE = Object.freeze({
  // retainRatio 取 DSH 自己的默认值 0.16，作为**下限**（不允许更低）。
  // thresholdRatio 必须严格大于它，取 0.18（留 2 个百分点给校验容差）。
  thresholdRatio: 0.18,
  retainRatio: 0.16,
  headroomTokens: 16384,
})

/**
 * 用户可改并持久化的字段。
 *
 * `headroomTokens` 故意**不在这里**：它是插件与预设快照之间的对齐值，不是用户
 * 偏好。早期版本把它也写进了 settings.json，结果旧文件里的 65536 会盖掉新默认值，
 * 让「按比例触发」失效。现在它只来自快照或行配置，用户文件里即使残留也会被忽略。
 *
 * `summarizerPolicy` 是「摘要是否追加判据」，属于要重新生成快照的选项，
 * 所以必须落盘 —— 靠环境变量的话，设置页点「修复」时读不到，会把功能悄悄关掉。
 */
export const USER_FIELDS = Object.freeze([
  'askRatio',
  'reAskRatio',
  'timeoutSeconds',
  'summarizerPolicy',
  'compactStrategy',
  'incrementGateTokens',
  'retainRatio',
  'quality',
])

/** 摘要策略：`stock` 用随包指令；`philosophy` 追加 KEEP/DROP/PRIORITY 判据。 */
export const SUMMARIZER_POLICIES = Object.freeze(['stock', 'philosophy'])

/** 区间选择策略：`stock` 尾部保留；`bc` 只压已消费增量。 */
export const COMPACT_STRATEGIES = Object.freeze(['stock', 'bc'])

/** 保留比例的允许范围：下限是 DSH 默认值 0.16，不允许更低。 */
export const RETAIN_RATIO_LIMITS = Object.freeze({ min: MIN_RETAIN_RATIO, max: 0.5, step: 1, scale: 100, unit: '%' })

/**
 * 界面可改的字段及其范围。
 *
 * `askRatio.min` 不是固定值：它随 `retainRatio` 走（见 `minAskRatioFor`）。
 * 这里给的是「保留比例为最低值 0.16 时」的下限，真实下限由
 * `resolveLimits(retainRatio)` 动态算。
 */
export const LIMITS = Object.freeze({
  askRatio: { min: MIN_ASK_RATIO_WITH_RETAIN, max: 0.95, step: 1, scale: 100, unit: '%' },
  reAskRatio: { min: 0.01, max: 0.3, step: 1, scale: 100, unit: '%' },
  timeoutSeconds: { min: 0, max: 3600, step: 30, scale: 1, unit: '秒' },
  retainRatio: RETAIN_RATIO_LIMITS,
})

/**
 * 按当前保留比例算出实际的界面范围。
 *
 * 这是任务 2 的核心：`retainRatio` 一降到底（0.16），询问阈值下限就锁到 22%。
 * 想再低就必须把保留比例降到 0.16 以下 —— 但那是 DSH 默认值的下限，不允许更低，
 * 所以**从这一版起阈值最低就是 22%**。这是有意的约束。
 *
 * @param retainRatio - 当前保留比例
 * @returns 与 `LIMITS` 同形的对象（`askRatio.min` 已替换）
 */
export function resolveLimits(retainRatio) {
  const floor = minAskRatioFor(retainRatio)
  return {
    ...LIMITS,
    askRatio: { ...LIMITS.askRatio, min: floor },
  }
}

/**
 * 质量档位：`off` / `lean` / `balanced` / `strict`（判据定义见 quality-rules.js）。
 *
 * `off` 表示**不注入任何判据**，用 DSH 随包指令 —— 与 `stock` 行为一致。
 * 加这一档是因为设置页需要一个「我不想动摘要」的明确选项，否则用户只能
 * 在三个档位里挑一个，没有退路。
 */
export const QUALITY_TIERS = Object.freeze(['off', 'lean', 'balanced', 'strict'])

export const SETTINGS_LABELS = Object.freeze({
  askRatio: '询问阈值',
  reAskRatio: '重问增长',
  timeoutSeconds: '等待上限',
  retainRatio: '保留比例',
  quality: '摘要质量',
  compactStrategy: '压缩区间策略',
  incrementGateTokens: '增量门控',
  summarizerPolicy: '摘要策略',
})

/** `$DSH_HOME`，与 DSH 自身的解析顺序一致：显式覆盖优先，否则 `~/.dsh`。 */
export function resolveDshHome(env = process.env) {
  const override = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return override === '' ? path.join(os.homedir(), '.dsh') : path.resolve(override)
}

export function settingsFile(home) {
  return path.join(home, 'compaction-ask', 'settings.json')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 把任意候选值收成合法设置。
 * 返回 `settings` 与 `problems`（每条都是给人看的一句话，指明被改成了什么）。
 */
export function normalizeSettings(candidate) {
  const input = isRecord(candidate) ? candidate : {}
  const problems = []
  const settings = { ...DEFAULTS }

  const ratio = (key, label, limits) => {
    const limit = limits ?? LIMITS[key]
    const raw = input[key]
    if (raw === undefined || raw === null) return DEFAULTS[key]
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) {
      problems.push(`${label}不是数字，保持 ${DEFAULTS[key] * limit.scale}${limit.unit}`)
      return DEFAULTS[key]
    }
    const clamped = clamp(value, limit.min, limit.max)
    if (Math.abs(clamped - value) > 1e-9) {
      problems.push(`${label}超出范围 ${limit.min * limit.scale}–${limit.max * limit.scale}${limit.unit}，已改为 ${Math.round(clamped * limit.scale)}${limit.unit}`)
    }
    return Math.round(clamped * 1000) / 1000
  }

  // ---- 质量档位先定，因为它会抬高保留比例的下限 ----
  if (input.quality !== undefined && input.quality !== null) {
    const raw = String(input.quality)
    if (QUALITY_TIERS.includes(raw)) {
      settings.quality = raw
    } else {
      problems.push(`摘要质量只能是 ${QUALITY_TIERS.join(' / ')}，已改为 ${DEFAULTS.quality}`)
    }
  }

  // ---- 保留比例：下限 0.16；高档位还要更高 ----
  const retainFloor = minRetainRatioFor(settings.quality)
  const rawRetain = Number(input.retainRatio)
  const retainTooLow = Number.isFinite(rawRetain) && rawRetain < retainFloor - 1e-9
  settings.retainRatio = ratio('retainRatio', SETTINGS_LABELS.retainRatio, {
    ...RETAIN_RATIO_LIMITS,
    min: retainFloor,
  })
  // 说清为什么被抬高 —— 通用「超出范围」解释不了「为什么是 20 不是 16」
  if (retainTooLow) {
    problems.length = Math.max(0, problems.length - (problems.some((p) => p.includes('保留比例超出范围')) ? 1 : 0))
    const why = settings.quality === 'strict'
      ? `摘要质量设为「严格」时，保留比例至少 ${Math.round(retainFloor * 100)}%（摘要更长，需要更大的原文窗口支撑）`
      : `保留比例的最低值是 ${Math.round(MIN_RETAIN_RATIO * 100)}%（DSH 默认值，不允许更低）`
    problems.push(`保留比例最低 ${Math.round(retainFloor * 100)}%，已从 ${Math.round(rawRetain * 100)}% 改为 ${Math.round(settings.retainRatio * 100)}%。原因：${why}。`)
  }

  // ---- 询问阈值：下限随保留比例联动 ----
  // 用户可能一次提交两个字段（例如 retainRatio 0.16 + askRatio 0.10），
  // 这里按**新的** retainRatio 算下限，所以顺序必须是先 retain 后 ask。
  const askFloor = minAskRatioFor(settings.retainRatio)
  const rawAsk = Number(input.askRatio)
  const askWasTooLow = Number.isFinite(rawAsk) && rawAsk < askFloor - 1e-9
  settings.askRatio = ratio('askRatio', SETTINGS_LABELS.askRatio, { ...LIMITS.askRatio, min: askFloor })

  // 联动说明：说清**为什么**被抬高。只在真的发生联动时给，且不与
  // 「超出范围」重复 —— 那种通用提示对用户没有解释力，这里替代它。
  if (askWasTooLow) {
    problems.length = Math.max(0, problems.length - (problems.some((p) => p.includes('询问阈值超出范围')) ? 1 : 0))
    problems.push(
      `询问阈值最低只能到 ${Math.round(askFloor * 100)}%，已从 ${Math.round(rawAsk * 100)}% 改为 ${Math.round(settings.askRatio * 100)}%。`
      + `原因：压缩引擎要求「保留比例 < 放行门槛 < 询问阈值」，当前保留比例 ${Math.round(settings.retainRatio * 100)}% 对应下限 ${Math.round(askFloor * 100)}%；`
      + `想设更低的阈值必须先降低保留比例，而保留比例最低是 ${Math.round(MIN_RETAIN_RATIO * 100)}%。`,
    )
  }

  settings.reAskRatio = ratio('reAskRatio', SETTINGS_LABELS.reAskRatio)

  const timeoutLimit = LIMITS.timeoutSeconds
  if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
    const value = Number(input.timeoutSeconds)
    if (!Number.isFinite(value)) {
      problems.push('等待上限不是数字，保持 300 秒')
    } else {
      const clamped = clamp(Math.round(value), timeoutLimit.min, timeoutLimit.max)
      if (clamped !== Math.round(value)) {
        problems.push(`等待上限超出范围 ${timeoutLimit.min}–${timeoutLimit.max} 秒，已改为 ${clamped} 秒`)
      }
      settings.timeoutSeconds = clamped
    }
  }

  // headroomTokens 不接受用户文件里的值（见 USER_FIELDS 的说明）：它由快照
  // 的 compaction-basic 行与守护行对齐，早期版本写进文件的旧值会悄悄改变触发点。
  // 忽略时给一句提示，免得升级后「明明改过却没生效」变成谜。
  if (input.headroomTokens !== undefined && input.headroomTokens !== DEFAULTS.headroomTokens) {
    problems.push(`文件里的 headroomTokens（${input.headroomTokens}）已忽略，改用插件内置的 ${DEFAULTS.headroomTokens}`)
  }

  // 摘要策略只认两个值；写错时退回 stock 并说明，不要静默留在奇怪状态
  if (input.summarizerPolicy !== undefined && input.summarizerPolicy !== null) {
    const raw = String(input.summarizerPolicy)
    if (SUMMARIZER_POLICIES.includes(raw)) {
      settings.summarizerPolicy = raw
    } else {
      problems.push(`摘要策略只能是 ${SUMMARIZER_POLICIES.join(' / ')}，已改为 ${DEFAULTS.summarizerPolicy}`)
    }
  }

  // 区间选择策略
  if (input.compactStrategy !== undefined && input.compactStrategy !== null) {
    const raw = String(input.compactStrategy)
    if (COMPACT_STRATEGIES.includes(raw)) {
      settings.compactStrategy = raw
    } else {
      problems.push(`区间策略只能是 ${COMPACT_STRATEGIES.join(' / ')}，已改为 ${DEFAULTS.compactStrategy}`)
    }
  }

  // 增量门控：太小会导致频繁压，太大则压不动。给一个宽松但有限的区间。
  if (input.incrementGateTokens !== undefined && input.incrementGateTokens !== null) {
    const value = Number(input.incrementGateTokens)
    if (!Number.isFinite(value)) {
      problems.push(`增量门控不是数字，保持 ${DEFAULTS.incrementGateTokens}`)
    } else {
      const clamped = clamp(Math.round(value), 1000, 500000)
      if (clamped !== Math.round(value)) {
        problems.push(`增量门控超出范围 1000–500000，已改为 ${clamped}`)
      }
      settings.incrementGateTokens = clamped
    }
  }

  return { settings, problems }
}

/** 读设置文件；缺失或损坏时返回默认值，绝不让插件因此起不来。 */
export function readSettings(home) {
  const file = settingsFile(home)
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8'))).settings
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写入设置文件，返回落盘后的设置与本次的修正说明。 */
export function writeSettings(home, candidate) {
  const { settings, problems } = normalizeSettings(candidate)
  // 只落用户字段：headroomTokens 属于插件与快照的对齐值，写进文件只会在下次
  // 升级时变成看不见的覆盖源。
  const persisted = {}
  for (const key of USER_FIELDS) persisted[key] = settings[key]
  const file = settingsFile(home)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
  return { settings, problems }
}

/**
 * 按 mtime 缓存的读取：守护逻辑每次 `agent/pre-step` 都会读一次，
 * 这里保证只有文件真的变了才重新解析。
 */
let cache = { file: null, mtimeMs: -1, size: -1, settings: null }

export function readSettingsCached(home) {
  const file = settingsFile(home)
  let stamp
  try {
    stamp = statSync(file)
  } catch {
    if (cache.file !== file) cache = { file, mtimeMs: -1, size: -1, settings: { ...DEFAULTS } }
    return cache.settings
  }
  if (cache.file === file && cache.mtimeMs === stamp.mtimeMs && cache.size === stamp.size) return cache.settings
  const settings = readSettings(home)
  cache = { file, mtimeMs: stamp.mtimeMs, size: stamp.size, settings }
  return settings
}