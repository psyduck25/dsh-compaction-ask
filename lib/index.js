/**
 * dsh-compaction-ask 的宿主行：给设置页开一组本地 HTTP 路由。
 *
 * 为什么用 `ctx.webServer.register` 而不是 Remote 服务：Remote 端点要在客户端
 * 声明生成类型，插件自建的业务接口用普通 HTTP 路由更直接（union-search、
 * xsd-studio 也走这条路）。所有路由只接受本机 loopback 请求。
 *
 * 路由：
 *   POST /api/dsh-compaction-ask/status    页面挂载时拉一次：当前参数、DSH 版本、
 *                                          快照是否与随包预设一致
 *   POST /api/dsh-compaction-ask/settings  读或写参数（写盘后守护行下一次 pre-step 生效）
 *   POST /api/dsh-compaction-ask/repair    按当前安装的 DSH 重新生成 preset 快照
 *
 * 注意：快照属于组合配置的一层，重写后要重启 DSH 才会被重新读取；接口如实返回
 * `restartRequired`，界面照它显示。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULTS,
  ENGINE,
  LIMITS,
  resolveLimits,
  readSettings,
  resolveDshHome,
  settingsFile,
  writeSettings,
} from './settings.js'
import {
  CONFLICTING_PACKAGES,
  enabledConflicts,
  profileManifestPath,
  readProfileManifest,
  resolveConflicts,
  switchCompactionOwner,
} from './conflicts.js'
import { inspectSnapshot, locateDsh, readDshVersion, repairSnapshot } from './preset.js'

export const ROUTE_PREFIX = '/api/dsh-compaction-ask'

/** 单次请求体上限：这里只收几个数字。 */
const MAX_BODY_BYTES = 64 * 1024

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const rowConfig = config !== null && typeof config === 'object' ? config : {}
  const home = typeof rowConfig.home === 'string' && rowConfig.home !== '' ? rowConfig.home : resolveDshHome()

  // ---- 启动时让路：本插件启用 ⇒ 把冲突插件从 profile.bundles 里移出去 ----
  // 原因：billion-context 的 gate 会把 compaction-basic 整行 disabled，
  // 两个同时启用会导致「问了但点压缩没反应」这类极难排查的状态。
  //
  // 失败一律静默：读不到/写不了 profile 只是「没让路」，不该让插件起不来。
  const conflict = safeResolveConflicts()
  if (conflict.checked && conflict.acted) {
    ctx.logger?.warn?.(
      `dsh-compaction-ask: 检测到 ${conflict.removed.join(', ')} 同时启用，已从 profile.bundles 移除以免抢压缩链路；`
      + `依赖仍保留，重启 DSH 后生效。如需切回请重新加入 bundles 并停用本插件。`,
    )
  }

  const status = async () => {
    const snapshot = await inspectSnapshot({ bundleDir: BUNDLE_DIR })
    const located = locateDsh()
    return {
      ok: true,
      bundleDir: BUNDLE_DIR,
      dshRoot: located?.root ?? null,
      dshVersion: await readDshVersion(),
      settingsPath: settingsFile(home),
      settings: readSettings(home),
      defaults: DEFAULTS,
      engine: { ...ENGINE, note: 'auto 已关闭，这个门槛只在你说「现在压缩」后决定引擎是否执行' },
      // limits 按当前保留比例动态算：askRatio 的下限随 retainRatio 走，
      // 客户端拿这个渲染输入框的 min/max，避免两边各写一份数字。
      limits: resolveLimits(readSettings(home).retainRatio),
      snapshot,
      // 冲突状态：每次都现读 profile 清单。这里只**报告**，不做写操作 ——
      // 真正的让路发生在插件启动的 apply 里（那时改一次就够了）。
      conflict: describeConflict(),
    }
  }

  const writeAndReport = (body) => {
    const candidate = body.reset === true ? { ...DEFAULTS } : body
    const { settings, problems } = writeSettings(home, candidate)
    return { ok: problems.length === 0, settings, problems }
  }

  const routes = [
    {
      path: `${ROUTE_PREFIX}/status`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: '只接受本机请求' })
        try {
          writeJson(response, 200, await status())
        } catch (error) {
          writeJson(response, 500, { ok: false, error: `读取状态失败：${messageOf(error)}` })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/settings`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: '只接受本机请求' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
        const wantsWrite = body.reset === true
          || typeof body.askRatio === 'number'
          || typeof body.reAskRatio === 'number'
          || typeof body.timeoutSeconds === 'number'
          || typeof body.headroomTokens === 'number'
          || typeof body.summarizerPolicy === 'string'
          || typeof body.compactStrategy === 'string'
          || typeof body.incrementGateTokens === 'number'
          || typeof body.retainRatio === 'number'
          || typeof body.quality === 'string'
        try {
          if (!wantsWrite) {
            return writeJson(response, 200, { ok: true, settings: readSettings(home), problems: [] })
          }
          const result = writeAndReport(body)
          ctx.logger?.info?.(`dsh-compaction-ask: 参数已保存 ${JSON.stringify(result.settings)}`)
          return writeJson(response, result.ok ? 200 : 200, { ...result, restartRequired: false })
        } catch (error) {
          return writeJson(response, 500, { ok: false, error: `保存参数失败：${messageOf(error)}` })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/repair`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: '只接受本机请求' })
        try {
          const result = await repairSnapshot({ bundleDir: BUNDLE_DIR })
          const snapshot = await inspectSnapshot({ bundleDir: BUNDLE_DIR })
          if (result.ok) {
            ctx.logger?.info?.(`dsh-compaction-ask: 快照修复 ${result.changed ? '已重写' : '无需改动'} -> ${result.path}`)
          } else {
            ctx.logger?.warn?.(`dsh-compaction-ask: 快照修复失败 ${result.message}`)
          }
          writeJson(response, 200, {
            ...result,
            dshVersion: await readDshVersion(),
            snapshot,
            restartRequired: result.ok && result.changed,
          })
        } catch (error) {
          writeJson(response, 500, { ok: false, changed: false, error: `修复失败：${messageOf(error)}` })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/conflicts`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: '只接受本机请求' })
        try {
          // 只读：报告当前是否有冲突插件被启用，不写文件。
          // 真正的「让路」发生在插件启动时（apply），不是这里。
          const file = profileManifestPath()
          const manifest = readProfileManifest(file)
          if (manifest === undefined) {
            return writeJson(response, 200, { ok: false, error: '读不到 profile 清单', path: file })
          }
          const conflicts = enabledConflicts(manifest)
          return writeJson(response, 200, {
            ok: true,
            path: file,
            conflicts,
            active: conflicts.length > 0,
            packages: CONFLICTING_PACKAGES,
          })
        } catch (error) {
          return writeJson(response, 500, { ok: false, error: `检测失败：${messageOf(error)}` })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/switch`,
      handler: async (request, response) => {
        if (!isLoopbackRequest(request)) return writeJson(response, 403, { ok: false, error: '只接受本机请求' })
        const body = await readJsonBody(request)
        if (body === undefined) return writeJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
        const target = body.target
        if (target !== 'self' && target !== 'bc') {
          return writeJson(response, 400, { ok: false, error: 'target 只能是 self 或 bc' })
        }
        try {
          const result = switchCompactionOwner(target)
          if (!result.ok) {
            ctx.logger?.warn?.(`dsh-compaction-ask: 切换失败 ${result.reason}`)
            return writeJson(response, 200, { ok: false, error: result.reason ?? '切换失败', path: result.path })
          }
          const label = target === 'self' ? '本插件' : CONFLICTING_PACKAGES[0]
          ctx.logger?.info?.(
            result.changed
              ? `dsh-compaction-ask: 已切换到 ${label}（added=${result.added.join(',')} removed=${result.removed.join(',')}），重启后生效`
              : `dsh-compaction-ask: 已经是 ${label} 启用状态，无需改动`,
          )
          return writeJson(response, 200, {
            ok: true,
            target,
            changed: result.changed,
            added: result.added,
            removed: result.removed,
            path: result.path,
            restartRequired: result.restartRequired,
            message: result.changed ? describeSwitch(target, result) : '已经是该状态下，没有改动。',
          })
        } catch (error) {
          return writeJson(response, 500, { ok: false, error: `切换失败：${messageOf(error)}` })
        }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: route.handler,
    }))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 已经随作用域一起释放了
        }
      }
    }
  }, 'dsh-compaction-ask: settings routes')

  ctx.logger?.info?.(`dsh-compaction-ask: 设置路由挂在 ${ROUTE_PREFIX}，参数文件 ${settingsFile(home)}`)
}

/**
 * 安全地执行冲突检测。
 *
 * 任何异常都吞掉并返回 { checked: false, ... } —— 这是锦上添花的功能，
 * 不该成为插件启动的失败点（看过 2026-11-25 那次「一行挂掉所有会话」的教训）。
 *
 * @returns resolveConflicts 的结果，或失败占位
 */
/**
 * 只读地报告当前冲突状态（给设置页显示用）。
 *
 * 不能调 resolveConflicts —— 那个会写文件。status 路由是高频读，
 * 如果每次都写盘就成了「打开设置页就改配置」。
 *
 * @returns { checked, conflicts, active, packages, reason? }
 */
function describeConflict() {
  try {
    const file = profileManifestPath()
    const manifest = readProfileManifest(file)
    if (manifest === undefined) {
      return { checked: false, conflicts: [], active: false, packages: CONFLICTING_PACKAGES, reason: '读不到 profile 清单' }
    }
    const conflicts = enabledConflicts(manifest)
    return { checked: true, conflicts, active: conflicts.length > 0, packages: CONFLICTING_PACKAGES }
  } catch (error) {
    return { checked: false, conflicts: [], active: false, packages: CONFLICTING_PACKAGES, reason: messageOf(error) }
  }
}

function safeResolveConflicts() {
  try {
    return resolveConflicts()
  } catch (error) {
    return { checked: false, conflicts: [], acted: false, reason: messageOf(error) }
  }
}

/**
 * 切换结果的说明文案。
 *
 * 单独抽成函数：模板字符串嵌套三元会在 `check` 时报语法错误（嵌套反引号），
 * 也不利于阅读。
 *
 * @param target - `self` 或 `bc`
 * @param result - `switchCompactionOwner` 的返回值
 * @returns 给人看的一句话
 */
function describeSwitch(target, result) {
  const label = target === 'self' ? '本插件' : CONFLICTING_PACKAGES[0]
  const parts = []
  if (result.added.length > 0) parts.push(`加入 ${result.added.join('、')}`)
  if (result.removed.length > 0) parts.push(`移除 ${result.removed.join('、')}`)
  return `已切换到${label}：${parts.join('，')}。请重启 DeepSeek Harness 生效。`
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 只放行本机页面发来的请求。 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  return true
}

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(payload)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return undefined
  }
}