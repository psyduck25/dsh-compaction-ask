/**
 * 摘要提示词增强的宿主行。
 *
 * 挂进压缩组当一个普通插件（不替换 `compaction-basic`）。它做两件事：
 *
 * 1. 监听 cordis 的 `internal/get` 瀑布，在 `llm` 被取值时返回一个代理，
 *    让 **purpose 为 `compaction` 的那次** `ctx.llm.stream()` 收到按当前
 *    质量档位生成的判据；其它调用一律原样透传。
 * 2. 提供 `summarizeWithQuality()`，把同一套档位判据用于「压缩后验收」——
 *    档位如果不影响验收，那它就只是装饰。
 *
 * 为什么不继承 `BasicCompactionEngine`：`@deepseek-ai/*` 是 asar 内置包，
 * profile 插件目录解析不到（实测 `require.resolve` 抛错）。一个
 * `ERR_MODULE_NOT_FOUND` 会让整个预设激活失败 —— 这个代价不值得冒。
 * 只认 `purpose` 字段则完全不需要那个依赖。
 *
 * 失败安全性：任何一步出问题都只是「没增强」，绝不影响压缩本身。
 */

import { wrapLlm } from './philosophy.js'
import { scoreSummary } from './quality.js'
import { readSettingsCached, resolveDshHome } from './settings.js'

export const name = 'compaction-ask-summary'

/** 档位缓存：按设置文件的 mtime 走，改完设置下一次摘要即生效。 */
function currentTier() {
  try {
    return readSettingsCached(resolveDshHome()).quality ?? 'balanced'
  } catch {
    return 'balanced'
  }
}

export function apply(ctx) {
  // 用 ctx.effect 注册，插件卸载时自动注销监听
  ctx.effect(() => ctx.on('internal/get', (_scope, prop, _error, next) => {
    const resolved = next()
    if (prop !== 'llm') return resolved
    try {
      // 每次取值都现读档位：设置页改完不用重启
      return wrapLlm(resolved, () => currentTier())
    } catch {
      // 包装失败就用原服务，绝不让压缩因为增强逻辑而挂掉
      return resolved
    }
  }))
}

/**
 * 按当前质量档位验收一份摘要。
 *
 * 暴露给 `lib/guard.js` 在压缩完成后调用：不合格时只记警告，不撤销压缩 ——
 * 撤销的代价（历史回滚 + 再压一次）远大于「摘要略差」。
 *
 * @param summaryText - 压缩产出的摘要文本
 * @param sourceText - 被压缩的原文（散文部分，见 `splitSource`）
 * @param tier - 档位；不传则读当前设置
 * @returns `scoreSummary` 的结果
 */
export function verifySummary(summaryText, sourceText, tier) {
  return scoreSummary(summaryText, sourceText, tier ?? currentTier())
}
