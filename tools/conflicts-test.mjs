/**
 * 冲突检测与自动让路的测试。
 *
 * 关键行为：
 *   1. 只有「在 dsh.profile.bundles 里」才算启用（安装不等于启用）；
 *   2. 检测到冲突要**移除 bundles 项但保留 dependencies**（方便切回）；
 *   3. 任何异常都不能抛 —— 这个功能不该成为插件启动的失败点。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CONFLICTING_PACKAGES,
  disableBundles,
  enabledConflicts,
  profileManifestPath,
  readProfileManifest,
  resolveConflicts,
  SELF_PACKAGE,
  switchBundles,
  switchCompactionOwner,
} from '../lib/conflicts.js'

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

/** 造一个临时 profile 目录。 */
function makeProfile(manifest) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-conflict-'))
  const file = path.join(dir, 'package.json')
  if (manifest !== undefined) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { dir, file }
}

// ---------------------------------------------------------------- 包名清单
{
  check(Array.isArray(CONFLICTING_PACKAGES), 'CONFLICTING_PACKAGES 是数组')
  check(CONFLICTING_PACKAGES.includes('billion-context'), '已知冲突包含 billion-context')
}

// ---------------------------------------------------------------- 路径推导
{
  const byDir = profileManifestPath({ DSH_PROFILE_DIR: 'C:\\profiles\\desktop' })
  check(byDir.endsWith('package.json'), 'DSH_PROFILE_DIR 优先', byDir)

  const byHome = profileManifestPath({ DSH_HOME: 'C:\\home', DSH_PROFILE: 'desktop' })
  check(byHome.includes('profiles') && byHome.endsWith('package.json'), '按 DSH_HOME + DSH_PROFILE 推', byHome)

  check(profileManifestPath({}) === undefined, '推不出来时返回 undefined')
}

// ---------------------------------------------------------------- 读清单
{
  const { dir, file } = makeProfile({ name: 'desktop' })
  const loaded = readProfileManifest(file)
  check(loaded?.name === 'desktop', '能读到清单')
  rmSync(dir, { recursive: true, force: true })

  check(readProfileManifest('/definitely/not/here.json') === undefined, '文件不存在返回 undefined')
  check(readProfileManifest(undefined) === undefined, '路径非法返回 undefined')

  const { dir: badDir, file: badFile } = makeProfile(undefined)
  writeFileSync(badFile, '{ 这不是 JSON', 'utf8')
  check(readProfileManifest(badFile) === undefined, '损坏的 JSON 返回 undefined 而不是抛错')
  rmSync(badDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 启用判定：只看 bundles
{
  const installedOnly = { dependencies: { 'billion-context': '^0.1.216' } }
  check(enabledConflicts(installedOnly).length === 0, '只安装不在 bundles 里 → 不算启用')

  const enabled = { dsh: { profile: { bundles: ['dsh-compaction-ask', 'billion-context'] } } }
  check(enabledConflicts(enabled).includes('billion-context'), '在 bundles 里 → 算启用')

  check(enabledConflicts({ dsh: { profile: { bundles: 'not-an-array' } } }).length === 0, 'bundles 非数组不崩')
  check(enabledConflicts(null).length === 0, 'null 安全')
  check(enabledConflicts(undefined).length === 0, 'undefined 安全')
  check(enabledConflicts({}).length === 0, '空对象安全')
}

// ---------------------------------------------------------------- 让路：移除 bundle、保留依赖
{
  const manifest = {
    name: 'desktop',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-compaction-ask', 'billion-context', 'dsh-xsd-studio'] } },
    dependencies: { 'billion-context': '^0.1.216', 'dsh-compaction-ask': 'link:...' },
  }
  const { dir, file } = makeProfile(manifest)
  const loaded = readProfileManifest(file)
  const result = disableBundles(file, loaded)

  check(result.ok && result.changed, '执行了移除')
  check(result.removed.includes('billion-context'), '报告移除了哪个包')

  const after = JSON.parse(readFileSync(file, 'utf8'))
  check(!after.dsh.profile.bundles.includes('billion-context'), 'bundles 里不再有 billion-context')
  check(after.dsh.profile.bundles.includes('dsh-compaction-ask'), '本插件仍在 bundles 里')
  check(after.dsh.profile.bundles.includes('dsh-xsd-studio'), '其他插件不受影响')
  check(after.dependencies['billion-context'] === '^0.1.216', '依赖保留，方便随时切回')

  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 无冲突时不动文件
{
  const manifest = { dsh: { profile: { bundles: ['dsh-compaction-ask'] } } }
  const { dir, file } = makeProfile(manifest)
  const before = readFileSync(file, 'utf8')
  const result = disableBundles(file, readProfileManifest(file))
  check(result.ok && !result.changed, '没有冲突时不改动')
  check(readFileSync(file, 'utf8') === before, '文件逐字未变')
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- resolveConflicts 端到端
{
  const manifest = {
    dsh: { profile: { bundles: ['dsh-compaction-ask', 'billion-context'] } },
    dependencies: { 'billion-context': '^0.1.216' },
  }
  const { dir, file } = makeProfile(manifest)
  const result = resolveConflicts({ DSH_PROFILE_DIR: dir })

  check(result.checked, '完成检测')
  check(result.acted, '执行了让路')
  check(result.conflicts.includes('billion-context'), '报告冲突')
  check(result.restartRequired === true, '提示需要重启')

  const after = JSON.parse(readFileSync(file, 'utf8'))
  check(!after.dsh.profile.bundles.includes('billion-context'), '文件已更新')
  rmSync(dir, { recursive: true, force: true })
}

{
  const manifest = { dsh: { profile: { bundles: ['dsh-compaction-ask'] } } }
  const { dir } = makeProfile(manifest)
  const result = resolveConflicts({ DSH_PROFILE_DIR: dir })
  check(result.checked && !result.acted && result.conflicts.length === 0, '无冲突时不动作')
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 异常安全
{
  const result = resolveConflicts({ DSH_PROFILE_DIR: '/definitely/not/here' })
  check(result.checked === false, '目录不存在时 checked=false')
  check(result.acted === false, '并明确没有执行任何动作')
  check(typeof result.reason === 'string', '给出原因')
}

{
  // bundles 缺失 → 不能抛，也不能假装做了什么
  const { dir, file } = makeProfile({ name: 'broken' })
  const result = resolveConflicts({ DSH_PROFILE_DIR: dir })
  check(result.checked === true && !result.acted, 'bundles 缺失时不动作')
  check(existsSync(file), '原文件仍在')
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 双向切换（二选一）
{
  const mk = (bundles) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-switch-'))
    const file = path.join(dir, 'package.json')
    writeFileSync(file, `${JSON.stringify({
      name: 'desktop',
      dsh: { profile: { bundles } },
      dependencies: { 'billion-context': '^0.1.216', 'dsh-compaction-ask': 'link:x' },
    }, null, 2)}\n`, 'utf8')
    return { dir, file }
  }

  // 当前是 BC → 切到本插件
  {
    const { dir, file } = mk(['@deepseek-ai/dsh-base', 'billion-context'])
    const r = switchCompactionOwner('self', { DSH_PROFILE_DIR: dir })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    check(r.ok && r.changed, '切到本插件：执行了改动')
    check(r.added.includes(SELF_PACKAGE), '加进了本插件')
    check(r.removed.includes('billion-context'), '移除了 BC')
    check(after.dsh.profile.bundles.includes(SELF_PACKAGE), '文件里本插件已启用')
    check(!after.dsh.profile.bundles.includes('billion-context'), '文件里 BC 已停用')
    check(after.dependencies['billion-context'] === '^0.1.216', 'BC 依赖保留，可切回')
    rmSync(dir, { recursive: true, force: true })
  }

  // 当前是本插件 → 切到 BC
  {
    const { dir, file } = mk(['@deepseek-ai/dsh-base', SELF_PACKAGE])
    const r = switchCompactionOwner('bc', { DSH_PROFILE_DIR: dir })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    check(r.ok && r.changed, '切到 BC：执行了改动')
    check(r.added.includes('billion-context'), '加进了 BC')
    check(r.removed.includes(SELF_PACKAGE), '移除了本插件')
    check(after.dsh.profile.bundles.includes('billion-context'), '文件里 BC 已启用')
    check(!after.dsh.profile.bundles.includes(SELF_PACKAGE), '文件里本插件已停用')
    check(after.dependencies[SELF_PACKAGE] === 'link:x', '本插件依赖保留')
    rmSync(dir, { recursive: true, force: true })
  }

  // 已经是目标状态 → 幂等
  {
    const { dir } = mk(['@deepseek-ai/dsh-base', SELF_PACKAGE])
    const r = switchCompactionOwner('self', { DSH_PROFILE_DIR: dir })
    check(r.ok && !r.changed, '重复点同一个按钮不改动')
    rmSync(dir, { recursive: true, force: true })
  }

  // 两者同时启用 → 切任一方都能清掉对方
  {
    const { dir, file } = mk([SELF_PACKAGE, 'billion-context'])
    switchCompactionOwner('self', { DSH_PROFILE_DIR: dir })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    check(!after.dsh.profile.bundles.includes('billion-context'), '两者并存时切本插件会清掉 BC')
    check(after.dsh.profile.bundles.includes(SELF_PACKAGE), '本插件留在 bundles')
    rmSync(dir, { recursive: true, force: true })
  }

  // 非法 target
  {
    const { dir } = mk([SELF_PACKAGE])
    const r = switchCompactionOwner('nonsense', { DSH_PROFILE_DIR: dir })
    check(!r.ok && typeof r.reason === 'string', '未知 target 被拒绝并给原因')
    rmSync(dir, { recursive: true, force: true })
  }

  // 清单不可读
  {
    const r = switchCompactionOwner('self', { DSH_PROFILE_DIR: '/definitely/not/here' })
    check(!r.ok, '读不到清单时失败而不是抛错')
  }

  // switchBundles 原子性
  {
    const { dir, file } = mk(['a', 'billion-context'])
    const manifest = readProfileManifest(file)
    const r = switchBundles(file, manifest, SELF_PACKAGE, ['billion-context'])
    const after = JSON.parse(readFileSync(file, 'utf8'))
    check(r.ok && r.changed, 'switchBundles 原子执行')
    check(after.dsh.profile.bundles.join(',') === 'a,dsh-compaction-ask', '结果同时包含新增与移除', after.dsh.profile.bundles.join(','))
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 冲突检测与自动让路正确')
