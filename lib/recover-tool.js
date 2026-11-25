/**
 * 把「还原被压缩的原文」做成模型可调用的工具。
 *
 * ## 为什么要自己拼工具对象
 *
 * DSH 的 `defineTool()` 来自 `@deepseek-ai/dsh-tools` —— 那是 asar 内置包，
 * 插件的 node_modules 里解析不到（实测 `require.resolve` 抛错）。但它的活
 * 只是「把参数描述转成 JSON Schema + 包一层校验」，工具对象本身长这样：
 *
 *   { name, description, parameters, output: { schema, render }, async execute(args, exec) }
 *
 * `ctx.tools.register()` 要的就是这个结构。所以这里手写它，跳过 `defineTool`，
 * 也就不需要任何 `@deepseek-ai/*` 依赖。
 *
 * ## 工具语义（对应 BC 的 decompress / search_context）
 *
 * - `context_recover`：还原某次压缩的原文，可指定第几次；
 * - `context_search`：在被压缩的历史里按关键词找回相关片段。
 *
 * 两者都**只读**：不写回 surface。要写回去等于撤销压缩，会破坏
 * `compaction/summary` 的记账，那不该由工具做。
 */

import { listCompactions, recoverCompaction, searchHistory } from './recover.js'

export const name = 'compaction-ask-recover'

/**
 * 宿主的工具注册表。必须声明：cordis 里访问未 inject 的服务会在
 * `ctx.tools` 取值时直接抛错，整个预设会因此校验失败（表现为所有会话不可用）。
 */
export const inject = ['tools']

/**
 * 注册两个工具。
 *
 * 用 `ctx.effect` 包一层，插件卸载时自动注销。
 *
 * @param ctx - 宿主上下文
 */
export function apply(ctx) {
  const tools = ctx.tools ?? ctx.get?.('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    ctx.logger?.warn?.('compaction-ask: tools 服务不可用，还原工具没有注册')
    return
  }

  const recover = buildRecoverTool()
  const search = buildSearchTool()

  ctx.effect(() => {
    const disposers = [tools.register(recover), tools.register(search)]
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 注销失败不影响卸载
        }
      }
    }
  })
}

/** 还原工具。 */
function buildRecoverTool() {
  return {
    name: 'context_recover',
    description: [
      '取回之前被上下文压缩抹掉的原始对话内容。',
      '压缩只是让这些内容不再出现在模型可见的上下文里，原始记录仍完整保存在会话日志中。',
      '当你需要某个早期细节（原始需求、某次报错原文、某个文件路径、之前的决定）而它已经被压缩掉时，用这个工具按次数还原。',
      '不带参数时返回最近一次压缩的原文。只读，不会撤销压缩。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: {
          type: 'number',
          description: '第几次压缩（从 1 开始）。不填则取最近一次。',
        },
        list_only: {
          type: 'boolean',
          description: '只列出所有压缩记录，不还原内容。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          header: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => value?.text ?? value?.header ?? JSON.stringify(value),
    },
    async execute(args, exec) {
      const session = exec?.agent?.session ?? exec?.session
      if (session === undefined) return { ok: false, text: '拿不到当前会话' }

      if (args?.list_only === true) {
        const records = listCompactions(session)
        if (records.length === 0) return { ok: true, text: '这个会话还没有被压缩过。' }
        const lines = records.map((record) => `第 ${record.id} 次：seq ${record.start}–${record.end}，${record.seqCount} 条事件，压缩掉约 ${record.tokens} tokens，摘要 ${record.summaryChars} 字`)
        return { ok: true, text: `共有 ${records.length} 次压缩：\n${lines.join('\n')}` }
      }

      const result = recoverCompaction(session, { index: args?.index })
      if (!result.ok) return { ok: false, text: result.error }
      return { ok: true, header: result.header, text: `${result.header}\n\n${result.text}` }
    },
  }
}

/** 搜索工具。 */
function buildSearchTool() {
  return {
    name: 'context_search',
    description: [
      '在被上下文压缩掉的历史里按关键词搜索。',
      '适合「我记得之前讨论过 X，但细节已经被压缩掉了」的情况：只返回匹配的片段，比整体还原更省。',
      '搜索范围只包括被压缩的部分，不包含当前可见的上下文。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: '关键词，大小写不敏感的子串匹配。',
        },
        limit: {
          type: 'number',
          description: '最多返回多少条，默认 20。',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => value?.text ?? JSON.stringify(value),
    },
    async execute(args, exec) {
      const session = exec?.agent?.session ?? exec?.session
      if (session === undefined) return { ok: false, text: '拿不到当前会话' }

      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20
      const result = searchHistory(session, args?.query, limit)
      if (!result.ok) return { ok: false, text: result.error }
      if (result.matches.length === 0) return { ok: true, text: `被压缩的历史里没有找到「${args.query}」。` }

      const lines = result.matches.map((match) => `[第 ${match.compaction} 次压缩 · seq ${match.seq} · ${match.type}]\n${match.excerpt}`)
      const tail = result.truncated ? `\n\n（已到 ${limit} 条上限，用 context_recover 还原更多）` : ''
      return { ok: true, text: `找到 ${result.matches.length} 条：\n\n${lines.join('\n\n')}${tail}` }
    },
  }
}
