/**
 * 宿主行路由的集成测试：用假的 ctx / request / response 调真实 handler。
 *
 *   node tools/routes-test.mjs
 *
 * 覆盖：status 结构、settings 读/写/夹紧、repair 重写快照并回到 in-sync、
 * 非本机请求被拒。
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundleDir = resolve(here, '..')
const host = await import(pathToFileURL(path.join(bundleDir, 'lib', 'index.js')).href)

const home = mkdtempSync(path.join(os.tmpdir(), 'compaction-ask-routes-'))

let failures = 0
const log = (name, extra = '') => console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`)
const check = (condition, name, detail = '') => {
  if (condition) log(name, detail)
  else {
    failures += 1
    console.error(`  FAIL ${name}: ${detail}`)
  }
}

/** 收路由表的假 ctx。 */
const handlers = new Map()
const ctx = {
  effect(fn) {
    return fn()
  },
  webServer: {
    register({ path: routePath, handler }) {
      handlers.set(routePath, handler)
      return () => handlers.delete(routePath)
    },
  },
  logger: { info() {}, warn() {} },
}
host.apply(ctx, { home })

check(handlers.size === 5, '注册了五条路由', [...handlers.keys()].join(', '))

/** 发一次假请求。 */
async function call(routePath, body, { loopback = true } = {}) {
  const handler = handlers.get(`${host.ROUTE_PREFIX}/${routePath}`)
  if (handler === undefined) throw new Error(`没有路由 ${routePath}`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const request = Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')])
  request.socket = { remoteAddress: loopback ? '127.0.0.1' : '10.0.0.9' }
  request.headers = { host: '127.0.0.1:11244', 'content-type': 'application/json' }
  let status = 0
  let raw = ''
  const response = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      raw = String(chunk ?? '')
    },
  }
  await handler(request, response)
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  return { status, body: parsed }
}

// --- status ---------------------------------------------------------------
{
  const { status, body } = await call('status', {})
  check(status === 200 && body?.ok === true, 'status 返回 ok', String(status))
  check(typeof body?.dshVersion === 'string' && body.dshVersion.length > 0, 'status 带上 DSH 版本', body?.dshVersion)
  check(Array.isArray([]) && typeof body?.settings?.askRatio === 'number', 'status 带上当前参数', JSON.stringify(body?.settings))
  check(typeof body?.snapshot?.status === 'string', 'status 带上快照状态', body?.snapshot?.status)
  check(body?.engine?.thresholdRatio === 0.18, 'status 公开引擎门槛 0.18')
  check(body?.engine?.retainRatio === 0.16, 'status 公开保留比例 0.16（DSH 默认值，下限）', String(body?.engine?.retainRatio))
  check(body?.limits?.askRatio?.min === 0.22, 'status 公开询问阈值下限 22%（随保留比例 0.16 联动）', String(body?.limits?.askRatio?.min))
  check(body?.snapshot?.path === path.join(bundleDir, 'cordis.patch.yml'), 'status 的快照路径正确')
}

// --- settings 读 -----------------------------------------------------------
{
  const { body } = await call('settings', {})
  check(body?.ok === true && body.settings.askRatio === 0.6, '空 body 是「读」', JSON.stringify(body?.settings))
}

// --- settings 写 -----------------------------------------------------------
{
  const { body } = await call('settings', { askRatio: 0.45, reAskRatio: 0.08, timeoutSeconds: 120 })
  check(body?.ok === true, '写参数成功', JSON.stringify(body?.problems))
  check(body?.settings?.askRatio === 0.45 && body.settings.timeoutSeconds === 120, '返回值是落盘后的参数')
  const file = path.join(home, 'compaction-ask', 'settings.json')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  check(onDisk.askRatio === 0.45 && onDisk.reAskRatio === 0.08, '参数确实写进了文件', file)
}

// --- settings 夹紧 ---------------------------------------------------------
{
  const { body } = await call('settings', { askRatio: 0.99, timeoutSeconds: 99999 })
  check(body?.settings?.askRatio === 0.95, '超范围阈值被夹到 95%', String(body?.settings?.askRatio))
  check(body?.settings?.timeoutSeconds === 3600, '超范围超时被夹到 3600 秒', String(body?.settings?.timeoutSeconds))
  check(Array.isArray(body?.problems) && body.problems.length === 2, '两条修正说明都回了', JSON.stringify(body?.problems))
}

// --- settings 恢复默认 -----------------------------------------------------
{
  const { body } = await call('settings', { reset: true })
  check(body?.settings?.askRatio === 0.6 && body.settings.reAskRatio === 0.05, '恢复默认参数')
}

// --- 非本机请求 -----------------------------------------------------------
{
  const { status } = await call('settings', {}, { loopback: false })
  check(status === 403, '非本机请求被拒', String(status))
}

// --- repair ---------------------------------------------------------------
{
  const before = readFileSync(path.join(bundleDir, 'cordis.patch.yml'), 'utf8')
  check(before.includes("- id: preset-standard"), '当前快照覆盖了 preset-standard')
  check(before.includes("name: 'dsh-compaction-ask/guard'"), '快照把守护行指向子路径导出')
  check(before.includes('auto: false'), '快照关掉了自动压缩')

  const { status, body } = await call('repair', {})
  check(status === 200 && body?.ok === true, 'repair 返回成功', body?.message ?? String(status))
  check(body?.snapshot?.status === 'in-sync', 'repair 之后快照与随包预设一致', body?.snapshot?.status)
  const after = readFileSync(path.join(bundleDir, 'cordis.patch.yml'), 'utf8')
  check(typeof body?.changed === 'boolean', 'repair 报告是否改动', String(body?.changed))
  check(after.includes("- id: preset-standard") && after.includes('auto: false'), '重写后的快照仍然可用')
  if (body?.changed === false) check(after === before, '未改动时文件逐字不变')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 宿主路由可用，修复后快照与当前安装的 DSH 一致')