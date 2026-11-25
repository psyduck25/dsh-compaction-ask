#!/usr/bin/env node
/**
 * 命令行版「修复」：和设置页里的按钮做同一件事 ——
 * 按当前安装的 DSH 重新生成 cordis.patch.yml。
 *
 *   node tools/sync-preset.mjs                       # 从已安装的 DSH 重新生成
 *   node tools/sync-preset.mjs --check               # 只检查是否过时（过时退出码 2）
 *   node tools/sync-preset.mjs --from file.yml       # 用一份已导出的随包预设生成
 *   node tools/sync-preset.mjs --dsh-dir "D:\DeepSeek Harness"
 *
 * 平时不需要运行它：装好插件后在 设置 → 压缩前询问 点「修复」即可。
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectSnapshot, readDshVersion, readShippedPreset, renderPatch, repairSnapshot, snapshotFile } from '../lib/preset.js'
import { readSettings, resolveDshHome } from '../lib/settings.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const dshRoot = option('--dsh-dir')
const from = option('--from')
const check = argv.includes('--check')

if (check) {
  const snapshot = await inspectSnapshot({ bundleDir: BUNDLE_DIR, dshRoot })
  if (snapshot.status === 'in-sync') {
    console.log(`快照与当前安装的 DSH 一致：${snapshot.path}`)
    process.exit(0)
  }
  console.error(`快照需要修复（${snapshot.status}）：${snapshot.message}`)
  console.error('点设置页的「修复」，或运行 node tools/sync-preset.mjs')
  process.exit(2)
}

if (from !== undefined) {
  const shipped = await readFile(from, 'utf8')
  // 显式传设置：--from 常用来预演/调试，行为和 repair 保持一致，
  // 否则「摘要增强开着」时用 --from 生成会把它丢掉。
  const next = renderPatch(shipped, readSettings(resolveDshHome()))
  const file = snapshotFile(BUNDLE_DIR)
  await writeFile(file, next, 'utf8')
  console.log(`已从 ${from} 生成 ${file}`)
  process.exit(0)
}

const result = await repairSnapshot({ bundleDir: BUNDLE_DIR, dshRoot })
if (result.ok) {
  console.log(result.message)
  console.log(`快照：${result.path}`)
  if (result.source !== undefined) console.log(`来源：${result.source}`)
  const version = await readDshVersion({ dshRoot })
  if (version !== null) console.log(`DSH 版本：${version}`)
  process.exit(0)
}
console.error(result.message)
process.exit(1)