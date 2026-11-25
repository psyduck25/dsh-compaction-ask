/**
 * 按质量档位生成摘要指令。
 *
 * ## 这一层为什么必须存在
 *
 * 任务要求「摘要质量分级要真的改变摘要」。光加一个 UI 下拉框、改一个字段，
 * 压缩行为一点没变 —— 那是假的。真正能改变摘要质量的只有两处：
 *
 *   1. **发给模型的指令**（本文件）—— 决定模型往哪个方向写；
 *   2. **压缩后的验收门槛**（`lib/quality.js`）—— 决定不合格的产物是否被拦下。
 *
 * 所以档位同时作用于这两处，缺一不可。
 *
 * ## 判据来源
 *
 * KEEP VERBATIM / DROP / PRIORITY 三段来自 **billion-context**（MIT，
 * 作者 Xianglei Ran / 冉祥磊）。本文件在它之上做了**分档**：
 *
 * - BC 只有一套固定的压缩哲学（外加 tier-1/2/3 三个**压缩层级**，
 *   那是「压摘要本身」，不是质量档位）；
 * - 这里把它拆成 lean / balanced / strict 三档，每档用不同的 KEEP 强度、
 *   不同的 DROP 容忍度、不同的 PRIORITY 序。
 *
 * BC 源码里 `summaryQuality` / `qualityLevel` / `compressionLevel` 的出现
 * 次数都是 0 —— 它**没有**摘要质量分级。分档是本插件加的。
 */

/** 所有档位共用的开场：先把「这段内容是过去」这件事钉死（BC 的 FRAMING 规则）。 */
const FRAMING = `FRAMING: the summary records the PAST as of this point. Label recorded task state as history ("TASK AS OF THIS CHECKPOINT: ..."), never as a live instruction, so a later reader treats it as settled context rather than something to re-execute. Write dense, scannable bullets. Every line must earn its place.`

/** 三档共用的硬性保留项：漏了这些，摘要就等于没说。 */
const HARD_KEEP = `MUST KEEP (all tiers, never paraphrase):
- Full file paths WITH line numbers and directory prefix (\`lib/hooks.ts:347\`). Never reduce to a bare filename — it cannot be grepped later.
- Error messages and stack traces, exact text (you need the literal string to search for it).
- Exact values: versions, config keys, thresholds, magic numbers.
- The user's overall goal and any change to it.
- Message refs of key anchors (\`m00420\`, \`m00510–m00520\`).`

/** 低档位的 DROP 规则：允许大幅丢弃，只留骨架。 */
const DROP_LIBERAL = `DROP aggressively — extract only the signal:
- ALL verbose logs, build/test output, directory listings, file dumps, search hits, successful tool outputs. Keep at most the one line that carries the finding.
- Duplicate reads, repeated status checks, exploratory dead-ends (keep one line: "tried X, failed because Y").
- Intermediate reasoning, back-and-forth discussion, self-corrections — keep the final position only.
- Long code snippets — keep the signature or the one load-bearing line.
Aim for the smallest summary that still lets a reader continue the task.`

/** 中档位的 DROP 规则：BC 原版的平衡点。 */
const DROP_BALANCED = `DROP — extract the signal, discard the vessel:
- Verbose logs (build/test/npm output) once the error line or result is captured.
- Duplicate file reads once the needed content is recorded.
- Consumed exploration (search hits, successful tool outputs) once the facts are extracted.
- Dead-end exploration — but KEEP the lesson in one line: "tried X, failed because Y".
- Back-and-forth discussion once the final position is captured; keep the outcome, drop the journey.
For each significant item you DROP, add a one-line CONTENT description of what it covered, not where it lives.`

/** 高档位的 DROP 规则：只丢真正无信息量的东西，尽量成段保留。 */
const DROP_STRICT = `DROP only what carries no information:
- Raw tool output is droppable ONLY after its key values (numbers, error strings, paths, test names) appear verbatim in the summary.
- Keep per-file and per-module resolutions, not just the aggregate conclusion.
- Keep the WHY behind each change, including alternatives considered and rejected.
- Keep numeric evidence: counts, timings, before/after values, thresholds.
- Keep every message ref for anything you compress, so a reader can jump back.
Strip formatting noise and restatement, not substance. A reader should be able to reconstruct the reasoning path without decompressing.`

/** 各档位的 PRIORITY 序（空间紧张时保什么）。 */
const PRIORITY_LEAN = `PRIORITY (tight space, keep in this order):
1. User's current goal and hard constraints.
2. What was decided.
3. The single next action.`

const PRIORITY_BALANCED = `PRIORITY — when space is tight, preserve in this order:
1. User's overall goal, goal evolution, intent, and hard constraints.
2. Decisions and rationale.
3. Exact technical artifacts: paths, signatures, errors, values.
4. Conclusions and key findings.
5. Lessons learned: what failed and why.`

const PRIORITY_STRICT = `PRIORITY — when space is tight, preserve in this order:
1. User's overall goal, goal evolution, intent, and hard constraints.
2. Decisions and rationale — including rejected alternatives and why they lost.
3. Exact technical artifacts: paths WITH line numbers, signatures, errors, values, thresholds.
4. Open objectives and unresolved questions (never drop these).
5. Conclusions, key findings, and their supporting numbers.
6. Lessons learned: what failed and why.`

/** 各档位的额外要求。 */
const EXTRA_LEAN = `Also: omit open objectives and next steps unless they are the user's current ask. Bullets only, no headers beyond the required sections.`

const EXTRA_BALANCED = `Also: keep a one-line \`Open objectives:\` entry for every user-requested objective that is neither completed nor superseded. Keep the rationale ("because") for each decision.`

const EXTRA_STRICT = `Also: keep a one-line \`Open objectives:\` entry for every user-requested objective that is neither completed nor superseded. Keep the rationale ("because") for EACH decision, including why rejected alternatives lost. Preserve per-file detail. Do not merge distinct decisions into one bullet.`

/** 档位 → 指令片段。 */
const TIER_RULES = Object.freeze({
  lean: [HARD_KEEP, DROP_LIBERAL, PRIORITY_LEAN, EXTRA_LEAN],
  balanced: [HARD_KEEP, DROP_BALANCED, PRIORITY_BALANCED, EXTRA_BALANCED],
  strict: [HARD_KEEP, DROP_STRICT, PRIORITY_STRICT, EXTRA_STRICT],
})

/**
 * 生成某个档位的摘要判据。
 *
 * 返回值会被追加到 DSH 随包的 compaction 指令后面（见 `lib/philosophy.js`）。
 *
 * `off` 档返回**空串**，而不是回退到 balanced：它的语义是「不注入判据」，
 * 回退会让用户选了「关闭」却仍然收到一整套规则 —— 那是无声的违背。
 * 空串由调用方（`enhanceStreamOptions`）判断后原样透传。
 *
 * @param tier - `off` | `lean` | `balanced` | `strict`
 * @returns 判据文本；`off` 或未知档位时为空串
 */
export function qualityRules(tier = 'balanced') {
  if (tier === 'off') return ''
  const parts = TIER_RULES[tier]
  if (parts === undefined) return ''
  return `ADDITIONAL RULES (these override any conflicting instruction above):\n\n${parts.join('\n\n')}\n\n${FRAMING}`
}

export const QUALITY_TIER_NAMES = Object.freeze(Object.keys(TIER_RULES))
