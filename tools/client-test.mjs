/**
 * 客户端模块的装载测试：不给浏览器，用假的 `window.__ModuleLoader__` 和
 * 一个最小的 React 替身，确认模块能被装载、`apply` 能注册设置页与图标。
 *
 *   node tools/client-test.mjs
 *
 * 它不能证明页面渲染出来长什么样（那要在浏览器里看），但能抓住模块格式、
 * 导出形状和 slot 注册上的错误。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = resolve(here, '..', 'lib', 'client.js')

let failures = 0
const log = (name, extra = '') => console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`)
const check = (condition, name, detail = '') => {
  if (condition) log(name, detail)
  else {
    failures += 1
    console.error(`  FAIL ${name}: ${detail}`)
  }
}

const code = await readFile(file, 'utf8')
let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })

new Function('window', 'fetch', code)(fakeWindow, fakeFetch)

check(captured !== null, '调用 __ModuleLoader__.load 注册了自己')
check(captured?.id === 'dsh-compaction-ask', '模块 id 等于包名', String(captured?.id))
check(typeof captured?.factory === 'function', '导出的是 factory(require)')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}
const module = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`意外的 require('${name}')`)
})

check(typeof module?.apply === 'function', '返回 apply(ctx)')
check(Array.isArray(module?.inject) && module.inject.includes('slots'), '声明了 slots 服务依赖', JSON.stringify(module?.inject))

const registrations = []
const ctx = {
  slots: {
    inject(name, run) {
      run()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
module.apply(ctx)

const section = registrations.find((entry) => entry.options?.name === 'settings.section')
const icon = registrations.find((entry) => entry.options?.name === 'settings.section.icon')
check(registrations.length === 2, '注册了两个 slot 贡献', registrations.map((r) => r.options?.name).join(', '))
check(section !== undefined, '注册了 settings.section')
check(section?.options?.id === 'compaction-ask', '分区 id 为 compaction-ask', String(section?.options?.id))
check(typeof section?.options?.label === 'function' && section.options.label() === '压缩询问', '分区标题是「压缩询问」')
check(typeof section?.component === 'function', '分区渲染组件是一个函数')
check(icon !== undefined && icon?.options?.id === section?.options?.id, '图标与分区用同一个 id', String(icon?.options?.id))
check(typeof icon?.component === 'function', '图标组件是一个函数')

// ---- 二选一切换按钮（2026-11-25 新增）----
{
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  check(source.includes('启用「压缩询问」'), '有「启用本插件」按钮')
  check(source.includes('启用 billion-context'), '有「启用 BC」按钮')
  check(source.includes('点了会改变什么'), '按钮旁有「会改变什么」说明')
  check(source.includes('交出压缩链路'), '说明 BC 会接管压缩链路')
  check(source.includes('失去'), '说明切换的代价')
  check(source.includes("doSwitch('self')") && source.includes("doSwitch('bc')"), '两个按钮分别调用 self / bc')
  check(source.includes("callHost('switch'"), '走 switch 端点')
}

// ---- 保存校验不能误伤布尔字段（2026-11-25 修复的 bug）----
{
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 「恢复默认」传的是 { reset: true }；校验循环必须跳过布尔值，
  // 否则 Number.isFinite(true) === false 会触发「「reset」需要一个数字。」
  check(
    source.includes("typeof value === 'boolean'"),
    '保存校验跳过布尔字段（否则「恢复默认」永远报错）',
  )
  check(source.includes('已恢复默认值'), '恢复默认的提示语与普通保存区分')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 客户端模块格式与 slot 注册正确（渲染效果需在浏览器里确认）')