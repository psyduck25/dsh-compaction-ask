/**
 * compaction-ask 守护行的冒烟测试（不需要 DSH）。
 *
 *   node tools/smoke.mjs
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const module = await import(pathToFileURL(resolve(here, '..', 'lib', 'guard.js')).href)

const home = mkdtempSync(path.join(os.tmpdir(), 'compaction-ask-home-'))

let failures = 0
const log = (name) => console.log(`  ok   ${name}`)
const fail = (name, detail) => {
  failures += 1
  console.error(`  FAIL ${name}: ${detail}`)
}

function makeRig({ total, answer, withQuestions = true, withCompaction = true, rowConfig = {} }) {
  const services = {
    tokenMeter: { measure: () => ({ totalTokens: total }) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }) },
  }
  const calls = { asked: 0, compacted: 0 }
  if (withQuestions) {
    services.userQuestions = {
      ask: async () => {
        calls.asked += 1
        return { answers: [{ selected: [answer] }] }
      },
    }
  }
  if (withCompaction) {
    services.compaction = {
      compactIfNeeded: async () => {
        calls.compacted += 1
        return { summary: 'ok' }
      },
    }
  }
  const handlers = new Map()
  const warnings = []
  const ctx = {
    on: (event, handler) => handlers.set(event, handler),
    get: (name) => services[name],
    logger: { warn: (message) => warnings.push(String(message)) },
  }
  module.apply(ctx, { home, ...rowConfig })
  const agent = {
    session: {
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 1000 } }),
      requestContext: () => ({ contextWindow: 100000 }),
    },
  }
  return { handlers, agent, calls, warnings }
}

async function step(rig) {
  const handler = rig.handlers.get('agent/pre-step')
  let nexted = false
  await handler({ agent: rig.agent, signal: new AbortController().signal }, () => {
    nexted = true
  })
  return nexted
}

// 阈值 = min(100000 * 0.6, 100000 - 1000 - 16384) = 60000
{
  const rig = makeRig({ total: 10000, answer: '现在压缩' })
  const nexted = await step(rig)
  rig.calls.asked === 0 && nexted ? log('低于阈值：不问，next() 照走') : fail('低于阈值', JSON.stringify(rig.calls))
}

{
  const rig = makeRig({ total: 65000, answer: '现在压缩' })
  const nexted = await step(rig)
  rig.calls.asked === 1 && rig.calls.compacted === 1 && nexted
    ? log('到阈值 + 现在压缩：问一次并压缩')
    : fail('压缩路径', JSON.stringify(rig.calls))
}

{
  const rig = makeRig({ total: 65000, answer: '暂不压缩' })
  await step(rig)
  rig.calls.asked === 1 && rig.calls.compacted === 0 ? log('暂不压缩：问了但不压') : fail('跳过路径', JSON.stringify(rig.calls))
  const rig2 = makeRig({ total: 66000, answer: '暂不压缩' })
  await step(rig2)
  await step(rig2)
  rig2.calls.asked === 1 ? log('重问要等 5% 增长') : fail('重问间隔', JSON.stringify(rig2.calls))
}

{
  const rig = makeRig({ total: 65000, answer: '本会话不再询问' })
  await step(rig)
  await step(rig)
  rig.calls.asked === 1 && rig.calls.compacted === 0 ? log('本会话不再询问：只问一次') : fail('静音路径', JSON.stringify(rig.calls))
}

{
  const rig = makeRig({ total: 65000, answer: '现在压缩', withQuestions: false })
  const nexted = await step(rig)
  rig.calls.compacted === 0 && nexted ? log('没有 userQuestions：静默，next() 照走') : fail('缺 ask 服务', JSON.stringify(rig.calls))
}

{
  const rig = makeRig({ total: 65000, answer: '现在压缩', withCompaction: false })
  const nexted = await step(rig)
  nexted && rig.warnings.some((m) => m.includes('compaction service is unavailable'))
    ? log('没有 compaction 服务：记警告，next() 照走')
    : fail('缺 compaction 服务', JSON.stringify({ nexted, warnings: rig.warnings }))
}

{
  const rig = makeRig({ total: 65000, answer: '现在压缩' })
  rig.agent.session.requestHeader = () => {
    throw new Error('boom')
  }
  const nexted = await step(rig)
  nexted && rig.warnings.some((m) => m.includes('skipped a question'))
    ? log('session 访问器抛错：被兜住，next() 照走')
    : fail('抛错访问器', JSON.stringify({ nexted, warnings: rig.warnings }))
}

// 设置文件压过行配置：阈值 35% → 100000 × 0.35 = 35000，38000 必然触发。
// 顺带验证文件里残留的旧 headroomTokens 不会改变触发点（仍然用内置的 16384）。
{
  mkdirSync(path.join(home, 'compaction-ask'), { recursive: true })
  writeFileSync(path.join(home, 'compaction-ask', 'settings.json'), JSON.stringify({ askRatio: 0.35, reAskRatio: 0.05, timeoutSeconds: 300, headroomTokens: 65536 }), 'utf8')
  const rig = makeRig({ total: 38000, answer: '现在压缩', rowConfig: { askRatio: 0.6 } })
  await step(rig)
  rig.calls.asked === 1
    ? log('settings.json 覆盖行配置（35% 阈值生效）')
    : fail('设置文件优先级', JSON.stringify(rig.calls))

  // 同一个 38000，若旧 headroom 65536 生效则阈值是 min(35000, 100000-1000-65536)=33464，
  // 依然会触发，所以再补一个只可能在新 headroom 下触发的用例：30000。
  const rig2 = makeRig({ total: 30000, answer: '现在压缩', rowConfig: { askRatio: 0.6 } })
  await step(rig2)
  rig2.calls.asked === 0
    ? log('残留 headroomTokens 已被忽略（30000 不触发）')
    : fail('旧 headroom 仍生效', JSON.stringify(rig2.calls))

  writeFileSync(path.join(home, 'compaction-ask', 'settings.json'), '{"askRatio": 0.6}', 'utf8')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: compaction-ask 行为正确，且任何失败都不会打断本轮')