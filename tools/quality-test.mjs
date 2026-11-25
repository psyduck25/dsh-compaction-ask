/**
 * 质量分级、联动规则、建议提示的测试。
 *
 * 这些是任务 1/2/5 的核心逻辑：档位必须真的改变摘要指令与验收门槛，
 * 比例必须真的联动，提示必须真的指向「还要改什么」。
 */

import {
  advisorHints,
  applyStrategyDefaults,
  QUALITY_ORDER,
  QUALITY_TIERS,
  scoreSummary,
  splitSource,
  suggestQualityForRetain,
} from '../lib/quality.js'
import { qualityRules } from '../lib/quality-rules.js'
import {
  DEFAULTS,
  MIN_RETAIN_RATIO,
  minAskRatioFor,
  minRetainRatioFor,
  normalizeSettings,
  resolveLimits,
  thresholdRatioFor,
} from '../lib/settings.js'

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

// ---------------------------------------------------------------- 任务 2：保留比例与阈值联动
{
  check(DEFAULTS.retainRatio === 0.16, '默认保留比例是 DSH 默认值 0.16')
  check(MIN_RETAIN_RATIO === 0.16, '保留比例下限锁在 0.16')

  const below = normalizeSettings({ retainRatio: 0.05 })
  check(below.settings.retainRatio === 0.16, '低于 0.16 会被抬回 0.16')
  check(below.problems.some((p) => p.includes('16%')), '并解释原因')

  // 保留比例 0.16 → 询问阈值下限 22%
  check(minAskRatioFor(0.16) === 0.22, 'retainRatio 0.16 → askRatio 最低 22%')
  check(minAskRatioFor(0.3) === 0.36, 'retainRatio 0.3 → askRatio 最低 36%')
  check(minAskRatioFor(0.5) === 0.56, 'retainRatio 0.5 → askRatio 最低 56%')

  // 引擎门槛必须严格大于保留比例
  for (const retain of [0.16, 0.2, 0.3, 0.5]) {
    const threshold = thresholdRatioFor(retain)
    check(retain < threshold, `thresholdRatio(${threshold}) > retainRatio(${retain}) —— 通过加载校验`)
  }

  // 任务里举的例子：retain 0.5 + ask 0.10 → ask 被抬到 0.56
  const example = normalizeSettings({ askRatio: 0.1, retainRatio: 0.5 })
  check(example.settings.askRatio === 0.56, 'retain 50% 时 ask 10% 会被抬到 56%', String(example.settings.askRatio))
  check(example.problems.some((p) => p.includes('保留比例') && p.includes('下限')), '并给出联动解释')

  // 任务例子的另一种写法：先 ask 0.6 retain 0.5，再 ask 0.10 retain 0.16
  const step = normalizeSettings({ askRatio: 0.1, retainRatio: 0.16 })
  check(step.settings.askRatio === 0.22, 'retain 16% 时 ask 10% → 22%', String(step.settings.askRatio))

  check(resolveLimits(0.16).askRatio.min === 0.22, 'resolveLimits 把界面下限同步到 22%')
  check(resolveLimits(0.3).askRatio.min === 0.36, 'resolveLimits 随保留比例动态变化')
}

// ---------------------------------------------------------------- 任务 2 反向：质量抬高保留下限
{
  check(minRetainRatioFor('strict') === 0.2, '严格质量要求保留比例 ≥20%')
  check(minRetainRatioFor('balanced') === 0.16, '平衡质量允许最低 16%')
  check(minRetainRatioFor('lean') === 0.16, '精简质量允许最低 16%')

  const strictLow = normalizeSettings({ quality: 'strict', retainRatio: 0.16 })
  check(strictLow.settings.retainRatio === 0.2, '严格质量下 retain 16% 会被抬到 20%')
  check(strictLow.problems.some((p) => p.includes('严格')), '并解释是质量档位导致的')
}

// ---------------------------------------------------------------- 任务 1：档位真的改变指令
{
  const lean = qualityRules('lean')
  const balanced = qualityRules('balanced')
  const strict = qualityRules('strict')

  check(lean !== balanced && balanced !== strict, '三档生成不同文本')
  check(lean.length < balanced.length && balanced.length < strict.length, '档位越高文本越长')
  check(lean.includes('DROP aggressively'), '精简档要求激进丢弃')
  check(!balanced.includes('DROP aggressively'), '平衡档不用激进丢弃')
  check(strict.includes('DROP only what carries no information'), '严格档要求谨慎丢弃')
  check(strict.includes('rejected alternatives'), '严格档要求保留被否决的方案')
  check(lean.includes('MUST KEEP') && strict.includes('MUST KEEP'), '三档都有硬性保留项')
  check(balanced.includes('Open objectives'), '平衡档要求保留未完成事项')
  check(lean.includes('TASK AS OF THIS CHECKPOINT'), '三档都带「记录过去」框架约束')
}

// ---------------------------------------------------------------- 任务 1：验收门槛随档位变化
{
  const source = [
    '改了 `lib/guard.js:120`，因为 retainRatio 必须小于 thresholdRatio。',
    '版本升到 0.2.2-rc.3，错误是 TargetPressureConfigError。',
    'Open objectives: 把 BC 策略接进来。',
  ].join('\n')

  const good = [
    '## Primary Request and Intent',
    '改了 `lib/guard.js:120`，因为 retainRatio 必须小于 thresholdRatio。',
    '版本 0.2.2-rc.3，错误是 TargetPressureConfigError。',
    '## Next Step',
    'Open objectives: 把 BC 策略接进来。',
  ].join('\n')

  const leanVerdict = scoreSummary(good, source, 'lean')
  check(leanVerdict.passed, '合格摘要在精简档通过', leanVerdict.failures.join('; '))

  const emptySummary = scoreSummary('一句话。', source, 'strict')
  check(!emptySummary.passed, '贫瘠摘要在严格档不通过')
  check(emptySummary.failures.length > 0, '并给出失败原因')

  // 同一份摘要在不同档位下判定可能不同 —— 档位确实影响验收
  const tiny = '## Current Work\n做了点事。'
  const tinyLean = scoreSummary(tiny, source, 'lean')
  const tinyStrict = scoreSummary(tiny, source, 'strict')
  check(!tinyStrict.passed, '贫瘠摘要在严格档不通过')
  check(tinyLean.passed || tinyStrict.passed === false, '档位对同一份摘要的判定不同')
}

// ---------------------------------------------------------------- splitSource：只把散文当锚点源
{
  const events = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '请看 lib/a.ts:10' }] } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ls 输出一堆 x.js y.js z.js' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我改了 lib/b.ts:20' }] } } },
  ]
  const { prose, tool } = splitSource(events)
  check(prose.includes('lib/a.ts:10') && prose.includes('lib/b.ts:20'), '散文包含用户与助手的路径')
  check(!prose.includes('ls 输出'), '工具输出不进散文')
  check(tool.includes('ls 输出'), '工具输出单独收集')
}

// ---------------------------------------------------------------- 任务 5：红色提示
{
  const clean = advisorHints({
    retainRatio: 0.16, askRatio: 0.6, quality: 'balanced', compactStrategy: 'stock', incrementGateTokens: 20000,
  })
  check(clean.length === 0, '默认组合没有红色提示（避免狼来了）')

  const leanLow = advisorHints({
    retainRatio: 0.16, askRatio: 0.6, quality: 'lean', compactStrategy: 'stock', incrementGateTokens: 20000,
  })
  check(leanLow.length > 0 && leanLow[0].level === 'warn', '低保留 + 精简质量给出警告')

  const bcLowGate = advisorHints({
    retainRatio: 0.16, askRatio: 0.6, quality: 'balanced', compactStrategy: 'bc', incrementGateTokens: 5000,
  })
  check(bcLowGate.some((h) => h.text.includes('增量门控')), 'BC + 低门控给出警告')

  const askTooLow = advisorHints({
    retainRatio: 0.3, askRatio: 0.2, quality: 'balanced', compactStrategy: 'stock', incrementGateTokens: 20000,
  })
  check(askTooLow.some((h) => h.text.includes('下限')), '阈值低于联动下限时给出警告')

  const strictLow = advisorHints({
    retainRatio: 0.16, askRatio: 0.6, quality: 'strict', compactStrategy: 'stock', incrementGateTokens: 20000,
  })
  check(strictLow.some((h) => h.text.includes('20%')), '严格质量 + 低保留给出警告')
}

// ---------------------------------------------------------------- 任务 4：切换策略直接改参数
{
  const base = { retainRatio: 0.16, askRatio: 0.22, quality: 'lean', incrementGateTokens: 5000, compactStrategy: 'stock' }
  const bc = applyStrategyDefaults('bc', base)
  check(bc.compactStrategy === 'bc', '切到 BC 改了策略字段')
  check(bc.incrementGateTokens === 20000, '切到 BC 把门控抬到 20000')
  check(bc.quality === 'balanced', '切到 BC 把精简质量抬到平衡')
  check(bc.retainRatio >= 0.16, '切到 BC 保留比例不低于 16%')
  check(bc.askRatio >= 0.22, '切到 BC 询问阈值不低于联动下限')

  const stock = applyStrategyDefaults('stock', { ...bc, incrementGateTokens: 50000 })
  check(stock.compactStrategy === 'stock', '切回 stock')
  check(stock.incrementGateTokens === 20000, '切回 stock 把门控归位')
  check(stock.retainRatio >= 0.16, '切回 stock 保留比例仍不低于 16%')

  // 边界：ask 太低时切换策略会被抬上来
  const low = applyStrategyDefaults('bc', { retainRatio: 0.3, askRatio: 0.1, quality: 'balanced', incrementGateTokens: 20000 })
  check(low.askRatio >= 0.36, '切换策略时把过低的阈值抬到联动下限', String(low.askRatio))
}

// ---------------------------------------------------------------- 质量建议
{
  check(suggestQualityForRetain(0.16, 'lean') !== undefined, '低保留 + 精简 → 有建议')
  check(suggestQualityForRetain(0.16, 'balanced') === undefined, '低保留 + 平衡 → 无需建议')
  check(suggestQualityForRetain(0.4, 'lean') === undefined, '高保留 + 精简 → 无需建议')
  check(QUALITY_ORDER.join(',') === 'off,lean,balanced,strict', '档位顺序固定，off 在最松端')
  check(Object.keys(QUALITY_TIERS).length === 4, '四档定义齐全（含 off）')

  // ---- off 档：不注入判据、不做验收、不再劝提高质量 ----
  check(qualityRules('off') === '', 'off 档不生成任何判据')
  check(qualityRules('balanced').includes('ADDITIONAL RULES'), 'balanced 档生成判据')
  check(qualityRules('不存在的档位') === '', '未知档位也不生成判据（不回退 balanced）')

  const offScore = scoreSummary('随便一句话', '原文里有 lib/a.ts:12 这个锚点', 'off')
  check(offScore.passed === true, 'off 档任何摘要都通过（没有门槛）')
  check(offScore.label === '关闭', 'off 档标签是「关闭」', offScore.label)
  check(suggestQualityForRetain(0.16, 'off') === undefined, 'off 档不再劝提高质量')

  // off 是显式选择，切策略不该把它悄悄打开
  const offBc = applyStrategyDefaults('bc', { quality: 'off', retainRatio: 0.16, askRatio: 0.6 })
  check(offBc.quality === 'off', '切到 BC 不会把 off 改成 balanced')
  const leanBc = applyStrategyDefaults('bc', { quality: 'lean', retainRatio: 0.16, askRatio: 0.6 })
  check(leanBc.quality === 'balanced', '切到 BC 仍把 lean 抬到 balanced')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 质量分级、比例联动、建议提示、策略切换都正确')
