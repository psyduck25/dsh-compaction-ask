/**
 * 检测「和本插件抢压缩链路」的插件是否被启用。
 *
 * ## 为什么需要
 *
 * billion-context 的 `bili-compaction-gate` 会在 `internal/config` 瀑布里把
 * `compaction-basic` 和 `command-compact` 整行 `disabled: true`。如果它和
 * 本插件**同时启用**，结果是：
 *
 * - 本插件照常弹问题，但你点「现在压缩」时 `ctx.compaction` 已经不存在；
 * - 或者加载顺序反过来，本插件被整行关掉，BC 的行为也不完整。
 *
 * 这种「装了但行为诡异」的状态最难排查，所以本插件主动检测并让路：
 * **本插件启用时，自动把 BC 从 `dsh.profile.bundles` 里移出去。**
 *
 * ## 只动 bundles，不动 dependencies
 *
 * 「启用」的唯一标志是 profile `package.json` 的 `dsh.profile.bundles` 数组。
 * 依赖留着不删 —— 用户随时可以再切回来，而且删依赖要走 pnpm，副作用大。
 *
 * ## 失败即放弃
 *
 * 读不到、写不了、结构不符 —— 一律返回「没处理」，绝不让本插件起不来。
 * 这个功能是锦上添花，不是启动前置条件。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDshHome } from './settings.js'

/** 已知会抢压缩链路的插件包名。 */
export const CONFLICTING_PACKAGES = Object.freeze(['billion-context'])

/**
 * profile 的 `package.json` 路径。
 *
 * `DSH_PROFILE_DIR` 优先（进程里已经有正确的 profile），否则按
 * `$DSH_HOME/profiles/<DSH_PROFILE>` 推。
 *
 * @param env - 环境变量
 * @returns 路径，或 undefined（推不出来时）
 */
export function profileManifestPath(env = process.env) {
  const direct = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : ''
  if (direct !== '') return path.join(direct, 'package.json')

  const profile = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  if (profile === '') return undefined
  return path.join(resolveDshHome(env), 'profiles', profile, 'package.json')
}

/**
 * 读 profile 清单。
 *
 * @param file - `package.json` 路径
 * @returns 解析后的对象，或 undefined
 */
export function readProfileManifest(file) {
  if (typeof file !== 'string' || !existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 找出「已启用」的冲突插件。
 *
 * @param manifest - profile 的 package.json 内容
 * @returns 命中 `dsh.profile.bundles` 的冲突包名数组
 */
export function enabledConflicts(manifest) {
  if (manifest === null || typeof manifest !== 'object') return []
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  return CONFLICTING_PACKAGES.filter((name) => bundles.includes(name))
}

/**
 * 从 `dsh.profile.bundles` 里移除冲突插件。
 *
 * 只写回这一处；`dependencies` 原样保留，方便随时切回。
 *
 * @param file - `package.json` 路径
 * @param manifest - 已解析的清单
 * @param names - 要移除的包名
 * @returns `{ ok, changed, removed, path }`
 */
export function disableBundles(file, manifest, names = CONFLICTING_PACKAGES) {
  if (typeof file !== 'string' || manifest === null || typeof manifest !== 'object') {
    return { ok: false, changed: false, removed: [], reason: '清单不可用' }
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    return { ok: false, changed: false, removed: [], reason: 'bundles 不是数组' }
  }

  const removed = bundles.filter((name) => names.includes(name))
  if (removed.length === 0) {
    return { ok: true, changed: false, removed: [], path: file }
  }

  manifest.dsh.profile.bundles = bundles.filter((name) => !names.includes(name))

  try {
    // 保持 2 空格缩进，和 DSH 自己写出来的一致
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return { ok: true, changed: true, removed, path: file }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      removed: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 本插件的包名。切换时要用。 */
export const SELF_PACKAGE = 'dsh-compaction-ask'

/**
 * 把某个包加入 / 移出 `dsh.profile.bundles`。
 *
 * 这是双向切换的底层操作：启用 A 时必须同时停用 B，因为两者抢同一条
 * 压缩链路。只改 bundles，不动 dependencies —— 依赖留着，随时切回。
 *
 * @param file - `package.json` 路径
 * @param manifest - 已解析的清单
 * @param enable - 要加入 bundles 的包名
 * @param disable - 要从 bundles 移除的包名
 * @returns `{ ok, changed, added, removed, path, reason? }`
 */
export function switchBundles(file, manifest, enable, disable = []) {
  if (typeof file !== 'string' || manifest === null || typeof manifest !== 'object') {
    return { ok: false, changed: false, added: [], removed: [], reason: '清单不可用' }
  }
  const profile = manifest?.dsh?.profile
  if (profile === undefined || profile === null || !Array.isArray(profile.bundles)) {
    return { ok: false, changed: false, added: [], removed: [], reason: 'bundles 不是数组' }
  }

  const before = [...profile.bundles]
  const added = before.includes(enable) ? [] : [enable]
  const removed = before.filter((name) => disable.includes(name) && name !== enable)

  let next = before.filter((name) => !removed.includes(name))
  if (added.length > 0) next.push(enable)

  if (added.length === 0 && removed.length === 0) {
    return { ok: true, changed: false, added: [], removed: [], path: file }
  }

  profile.bundles = next

  try {
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return { ok: true, changed: true, added, removed, path: file }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      added: [],
      removed: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 双向切换：二选一。
 *
 * @param target - `'self'`（启用本插件）或 `'bc'`（启用 billion-context）
 * @param env - 环境变量
 * @returns 切换结果，或失败原因
 */
export function switchCompactionOwner(target, env = process.env) {
  const file = profileManifestPath(env)
  if (file === undefined) {
    return { ok: false, changed: false, reason: '推不出 profile 路径' }
  }
  const manifest = readProfileManifest(file)
  if (manifest === undefined) {
    return { ok: false, changed: false, reason: '读不到 profile 清单', path: file }
  }

  if (target === 'self') {
    const result = switchBundles(file, manifest, SELF_PACKAGE, CONFLICTING_PACKAGES)
    return { ...result, target, restartRequired: result.changed, path: file }
  }
  if (target === 'bc') {
    const result = switchBundles(file, manifest, CONFLICTING_PACKAGES[0], [SELF_PACKAGE])
    return { ...result, target, restartRequired: result.changed, path: file }
  }
  return { ok: false, changed: false, reason: `未知的切换目标：${String(target)}`, path: file }
}

/**
 * 一次完成：检测 + 让路。
 *
 * @param env - 环境变量
 * @returns `{ checked, conflicts, acted, removed, reason?, path? }`
 */
export function resolveConflicts(env = process.env) {
  const file = profileManifestPath(env)
  if (file === undefined) {
    return { checked: false, conflicts: [], acted: false, reason: '推不出 profile 路径' }
  }
  const manifest = readProfileManifest(file)
  if (manifest === undefined) {
    return { checked: false, conflicts: [], acted: false, reason: '读不到 profile 清单', path: file }
  }

  const conflicts = enabledConflicts(manifest)
  if (conflicts.length === 0) {
    return { checked: true, conflicts: [], acted: false, path: file }
  }

  const result = disableBundles(file, manifest, conflicts)
  return {
    checked: true,
    conflicts,
    acted: result.changed,
    removed: result.removed,
    reason: result.reason,
    path: file,
    restartRequired: result.changed,
  }
}
