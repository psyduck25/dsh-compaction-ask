/**
 * 预设行的「启动自检」。
 *
 * ## 为什么要有这个测试
 *
 * 2026-11-25 的事故：`recover-tool.js` 里写了 `ctx.tools`，但没声明
 * `export const inject = ['tools']`。cordis 在未声明注入时取值就抛错，
 * 于是这一行 `not started`，**整个 standard 预设校验失败** ——
 * 代价是所有会话不可用（标题退化成 uuid、输入框变「会话不可用」）。
 *
 * 当时 8 套测试全绿，因为**它们只测纯逻辑**（philosophy/range/recover 这些
 * 没有 apply 的模块），从不加载 DSH 真正会挂载的那几个入口文件。
 *
 * 这个测试补上那个洞：把快照里每一个 `dsh-compaction-ask/*` 行对应的模块
 * 真实 import 一遍，并用「最苛刻但合法的假 ctx」调用它的 apply，
 * 确认：
 *   1. 模块能 import（没有语法/导入错误）；
 *   2. 有 `name`；
 *   3. 用到的服务要么声明在 `inject` 里，要么走 `ctx.get()`；
 *   4. apply 不抛错。
 *
 * 它不能替代真实启动（拿不到真的 cordis），但能挡住这一整类"一票否决"错误。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundleDir = path.resolve(here, '..')

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

// ---------------------------------------------------------------- 收集快照行

const snapshot = await readFile(path.join(bundleDir, 'cordis.patch.yml'), 'utf8')

/** 找出所有 `dsh-compaction-ask/xxx` 形式的 specifier。 */
function mountedSpecifiers(text) {
  const found = new Set()
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*name:\s*'(dsh-compaction-ask\/[a-z-]+)'/)
    if (match) found.add(match[1])
  }
  return [...found].sort()
}

const specifiers = mountedSpecifiers(snapshot)
check(specifiers.length > 0, '快照里能找到本插件的行', String(specifiers.length))

// ---------------------------------------------------------------- 逐个加载

/**
 * 造一个「最苛刻」的假 ctx。
 *
 * 刻意只提供最基础的几个成员，并把所有服务访问都记下来 ——
 * 这样未声明的服务访问会像在 cordis 里一样暴露出来（我们用一个
 * Proxy 让未声明的服务返回 undefined，而不是静默给个对象）。
 */
function makeCtx(declared) {
  const accessed = []
  const target = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn) => {
      // cordis 的 effect 立即执行回调并保管 disposer
      const dispose = fn()
      return dispose
    },
    on: () => () => {},
    get: (name) => {
      accessed.push(`ctx.get('${name}')`)
      return undefined
    },
  }

  // 已声明的服务给一个最小可用替身；未声明的一律 undefined
  if (declared.includes('tools')) {
    target.tools = {
      register: (tool) => {
        if (tool === null || typeof tool !== 'object') throw new Error('register 收到非对象')
        if (typeof tool.name !== 'string' || tool.name === '') throw new Error('工具缺 name')
        if (typeof tool.execute !== 'function') throw new Error(`工具 ${tool.name} 缺 execute`)
        return () => {}
      },
    }
  }
  if (declared.includes('webServer')) {
    target.webServer = { register: () => () => {} }
  }

  return { ctx: target, accessed }
}

for (const specifier of specifiers) {
  const entry = specifier.slice('dsh-compaction-ask/'.length)
  const file = path.join(bundleDir, 'lib', `${entry}.js`)

  let module
  try {
    module = await import(`file://${file.replace(/\\/g, '/')}`)
  } catch (error) {
    fail(`${entry}: 模块加载失败`, error.message)
    continue
  }
  log(`${entry}: 模块可加载`)

  check(typeof module.name === 'string' && module.name !== '', `${entry}: 声明了 name`, JSON.stringify(module.name))
  check(typeof module.apply === 'function' || typeof module.default === 'function', `${entry}: 有 apply`)

  const declared = Array.isArray(module.inject) ? module.inject : []
  const apply = typeof module.apply === 'function' ? module.apply : module.default
  if (typeof apply !== 'function') continue

  const { ctx } = makeCtx(declared)
  try {
    await apply(ctx, {})
    log(`${entry}: apply 不抛错（inject: ${declared.length > 0 ? declared.join(',') : '无'}）`)
  } catch (error) {
    fail(`${entry}: apply 抛错（会让整行 not started，所有会话不可用）`, error.message)
  }
}

// ---------------------------------------------------------------- 静态检查：裸访问 ctx.xxx

/**
 * 扫描源码里的 `ctx.<service>` 裸访问，对照 inject 声明。
 *
 * 这类错误在 cordis 里是「取值即抛」，但很多情况静态就能看出来。
 * 只对**会被挂载的入口文件**做，纯逻辑模块没有 ctx 参数，不适用。
 *
 * `logger` 不在检查范围：它是 JSONRPC/日志服务在**每个 context 上直接
 * 挂载**的成员，不是需要声明的服务。实证：DSH 里 87 个官方包用了
 * `ctx.logger`，其中 30 个有 inject 声明，**没有一个**把 logger 写进 inject。
 * 把它标成问题会导致假阳性，反而诱导别人加一个错误的 inject。
 */
const SERVICE_NAMES = [
  'tools', 'webServer', 'llm', 'compaction', 'tokenMeter', 'userQuestions',
  'sessions', 'systemPrompt', 'sessionProjections', 'settings', 'sandbox', 'shell',
]

for (const specifier of specifiers) {
  const entry = specifier.slice('dsh-compaction-ask/'.length)
  const file = path.join(bundleDir, 'lib', `${entry}.js`)
  const source = await readFile(file, 'utf8')
  const module = await import(`file://${file.replace(/\\/g, '/')}`).catch(() => undefined)
  const declared = Array.isArray(module?.inject) ? module.inject : []

  for (const service of SERVICE_NAMES) {
    // 匹配 ctx.tools 这类裸访问；`ctx.get('tools')` 和注释不算
    const pattern = new RegExp(`ctx\\.${service}\\b`, 'g')
    const matches = [...source.matchAll(pattern)]
    if (matches.length === 0) continue

    // 排除注释行：粗略按行判断
    const realAccess = matches.filter((match) => {
      const before = source.slice(0, match.index)
      const lineStart = before.lastIndexOf('\n') + 1
      const line = source.slice(lineStart, source.indexOf('\n', match.index))
      const trimmed = line.trim()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//')
    })
    if (realAccess.length === 0) continue

    check(
      declared.includes(service),
      `${entry}: 裸访问 ctx.${service} 已声明在 inject`,
      `inject=[${declared.join(',') || ''}]`,
    )
  }
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  console.error('')
  console.error('注意：这类错误不是「少个功能」，而是整个预设校验失败、所有会话不可用。')
  process.exit(1)
}
console.log('PASS: 快照里的每个行都能安全启动')
