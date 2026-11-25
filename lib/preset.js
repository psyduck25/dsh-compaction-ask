/**
 * 预设快照的生成、比对与修复。
 *
 * 背景：DSH 的自动压缩开关是 `standard` 预设里 `compaction-basic` 那一行的
 * `config`，而预设行只能**整份**替换（patch 的 config 不做深合并）。所以本插件
 * 的 `cordis.patch.yml` 里有一份「随包 standard 预设的低配快照 + 压缩组两处改动」。
 *
 * 快照会随 DSH 升级而陈旧：随包预设变了，快照不会自己变。这个模块负责
 *
 *   renderPatch()   从安装目录读出随包预设，生成应该写进 cordis.patch.yml 的全文
 *   inspectSnapshot() 比对磁盘上的快照与当前安装版本，报告是否同步
 *   repairSnapshot()  重写快照（设置页的「修复」按钮与 tools/sync-preset.mjs 共用）
 *
 * 这样用户不需要记任何命令：升级后点一下修复即可。
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULTS, ENGINE, readSettings, resolveDshHome } from './settings.js'

export const PACKAGE_NAME = 'dsh-compaction-ask'

/** 随包预设在这个安装版本里的位置（asar 内路径）。 */
const SHIPPED_PRESET_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'

/** 本插件在预设里挂的守护行；子路径导出，和宿主行分开。 */
const GUARD_SPECIFIER = `${PACKAGE_NAME}/guard`

/** 摘要增强行：只追加判据，不替换 compaction-basic。 */
const SUMMARY_SPECIFIER = `${PACKAGE_NAME}/summarizer`

/** 还原工具行：给模型提供 context_recover / context_search。 */
const RECOVER_SPECIFIER = `${PACKAGE_NAME}/recover-tool`

/** 随包原生引擎。 */
const STOCK_ENGINE_SPECIFIER = '@deepseek-ai/dsh-compaction-basic'

/**
 * 是否挂摘要增强行（追加 KEEP/DROP/PRIORITY 判据）。
 *
 * 读**设置文件**而不是环境变量：设置页的「修复」按钮和 `sync-preset.mjs`
 * 必须得到同一个答案。用环境变量的话，按钮那条路径读不到，一按修复就会把
 * 用户打开的功能悄悄关掉 —— 那种 bug 极难查。
 *
 * `renderPatch` 拿到的是「当前设置」，由调用方传入，保持本函数纯净可测。
 */
function summarizerEnabled(settings) {
  // 摘要增强行的挂载条件。
  //
  // 这里曾经只看 `summarizerPolicy === 'philosophy'`，但那个字段**没有暴露到
  // 设置页**，用户永远改不到它，于是「摘要质量」三档选了也白选 ——
  // summarizer 行从不挂载，quality 完全不生效（2026-11-26 审查发现的 bug）。
  //
  // 现在的判定改成「只要 quality 不是 off 就挂」：
  //   - quality 是设置页上真实可改的下拉，选了就生效；
  //   - 保留 summarizerPolicy 作为显式开关（'philosophy' 强制开，'stock' 不再一票否决）。
  //
  // 换句话说：quality 决定「用哪套判据」，summarizerPolicy 只在显式设成
  // 'philosophy' 时充当强制开启。两者任一为真即挂载。
  const quality = settings?.quality
  if (quality === 'off') return false
  if (settings?.summarizerPolicy === 'philosophy') return true
  return quality === 'lean' || quality === 'balanced' || quality === 'strict'
}

function headerText() {
  return `# ${PACKAGE_NAME}（压缩询问）— 覆盖随包 standard 预设，让上下文压缩先问人。
#
# 本文件由插件自己生成：设置页的「修复」按钮或 tools/sync-preset.mjs 会根据
# 当前安装的 DSH 重写它。手改会在下次修复时被覆盖。
#
# 与随包预设的差别只有两处：
#   - compaction-basic：auto: false（不自动压缩）；thresholdRatio ${ENGINE.thresholdRatio} 与
#     retainRatio ${ENGINE.retainRatio} 是「你同意后才放行」的引擎门槛，压低它们
#     才能让询问阈值低到 22%（引擎要求「保留比例 < 放行门槛 < 询问阈值」）
#   - compaction-ask：本插件的守护行，按设置里的阈值询问你
#
# 卸载本插件即回到随包默认行为（自动压缩）。
`
}

/**
 * 从 asar 里读一个文件。
 *
 * 两种环境都要能跑：
 * - DSH 自身的进程里装了 asar 文件系统垫片（否则它没法从 app.asar 加载代码），
 *   所以把归档当目录读是最直接的方式；
 * - 纯 node（例如命令行跑 tools/sync-preset.mjs）没有垫片，那条路径会 ENOENT，
 *   于是退回自己解析归档头 —— 不依赖 @electron/asar，也不改写任何文件。
 */
export async function readAsarEntry(asarPath, entryPath) {
  try {
    return await readFile(path.join(asarPath, entryPath), 'utf8')
  } catch {
    // 没有垫片，或者条目确实不在，交给下面的解析器再试一次
  }
  const archive = await readFile(asarPath)
  const headerPickleSize = archive.readUInt32LE(4)
  const jsonLength = archive.readUInt32LE(12)
  const header = JSON.parse(archive.subarray(16, 16 + jsonLength).toString('utf8'))
  let node = header
  for (const segment of entryPath.split('/')) {
    node = node.files?.[segment]
    if (node === undefined) throw new Error(`${entryPath} 不在 ${asarPath} 里（缺少 ${segment}）`)
  }
  if (typeof node.offset !== 'string' || typeof node.size !== 'number') {
    throw new Error(`${entryPath} 在 ${asarPath} 里不是一个文件条目`)
  }
  const start = 8 + headerPickleSize + Number(node.offset)
  return archive.subarray(start, start + node.size).toString('utf8')
}

/**
 * 找 DSH 安装目录。
 * Electron 主进程里 `process.resourcesPath` 就是 `<安装目录>/resources`；
 * 纯 node 下退回常见安装位置。都找不到时抛错，由调用方把原因显示给用户。
 */
export function dshRootCandidates(env = process.env) {
  const candidates = []
  if (typeof env.DSH_INSTALL_DIR === 'string' && env.DSH_INSTALL_DIR.trim() !== '') {
    candidates.push(path.resolve(env.DSH_INSTALL_DIR.trim()))
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.dirname(process.resourcesPath))
  }
  for (const drive of ['C', 'D', 'E', 'F']) candidates.push(`${drive}:\\DeepSeek Harness`)
  if (process.platform === 'darwin') candidates.push('/Applications/DeepSeek Harness.app/Contents')
  if (process.platform === 'linux') candidates.push('/opt/DeepSeek Harness')
  return [...new Set(candidates)]
}

export function locateDsh(env = process.env) {
  for (const root of dshRootCandidates(env)) {
    const asar = path.join(root, 'resources', 'app.asar')
    if (existsSync(asar)) return { root, asar }
  }
  return null
}

/** 读随包 standard 预设的原文。 */
export async function readShippedPreset({ dshRoot, env = process.env } = {}) {
  if (dshRoot !== undefined && dshRoot !== null) {
    const asar = path.join(dshRoot, 'resources', 'app.asar')
    if (!existsSync(asar)) throw new Error(`${dshRoot} 下没有 resources/app.asar`)
    return { text: await readAsarEntry(asar, SHIPPED_PRESET_ENTRY), source: asar }
  }
  const located = locateDsh(env)
  if (located === null) throw new Error('找不到 DSH 安装目录（可以设置 DSH_INSTALL_DIR 指定）')
  return { text: await readAsarEntry(located.asar, SHIPPED_PRESET_ENTRY), source: located.asar }
}

/** 读安装版本号（asar 里的 dsh/package.json）。失败返回 null，不影响修复。 */
export async function readDshVersion({ dshRoot, env = process.env } = {}) {
  try {
    const asar = dshRoot !== undefined && dshRoot !== null ? path.join(dshRoot, 'resources', 'app.asar') : locateDsh(env)?.asar
    if (asar === undefined || asar === null) return null
    const manifest = JSON.parse(await readAsarEntry(asar, 'dsh/package.json'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** 随包补丁的 `- insert:` 外壳换成覆盖行，字段一个不动。 */
function toOverrideRow(shipped) {
  const lines = shipped.split(/\r?\n/)
  const insertAt = lines.findIndex((line) => /^-\s*insert:\s*$/.test(line))
  if (insertAt < 0) throw new Error('随包补丁里没有 "- insert:" 块，格式已变化')
  const rows = lines.slice(insertAt + 1)
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  const dedented = rows.map((line) => (line.startsWith('    ') ? line.slice(4) : line))
  if (!dedented.some((line) => /^- id: preset-standard\s*$/.test(line))) {
    throw new Error('随包补丁里没有插入 preset-standard，格式已变化')
  }
  return dedented
}

/** 压缩组的孩子整段换成「关掉自动压缩 + 插入守护行」。 */
function rewriteCompaction(lines, settings) {
  const groupAt = lines.findIndex((line) => /^(\s*)- id: compaction\s*$/.test(line))
  if (groupAt < 0) throw new Error('预设列表里没有 compaction 组，格式已变化')
  const indent = /^(\s*)/.exec(lines[groupAt])[1]
  const childIndent = `${indent}    `
  const childAt = lines.findIndex((line, index) => index > groupAt && line.startsWith(`${childIndent}- id: `))
  if (childAt < 0) throw new Error('compaction 组没有子行，格式已变化')

  let end = lines.length
  for (let index = childAt; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const lineIndent = /^(\s*)/.exec(line)[1]
    if (lineIndent.length <= indent.length && line.trimStart().startsWith('- ')) {
      end = index
      break
    }
  }

  const children = [
    '- id: compaction-basic',
    `  name: '${STOCK_ENGINE_SPECIFIER}'`,
    '  config:',
    '    auto: false # 不自动压缩：只有回答「现在压缩」才会压缩',
    `    thresholdRatio: ${ENGINE.thresholdRatio} # 放行门槛：必须低于询问阈值，否则点了压缩引擎会拒绝`,
    `    retainRatio: ${ENGINE.retainRatio} # 必须小于 thresholdRatio（加载校验）`,
    `    headroomTokens: ${ENGINE.headroomTokens}`,
    '- id: compaction-ask',
    `  name: '${GUARD_SPECIFIER}'`,
    '  config:',
    `    askRatio: ${DEFAULTS.askRatio} # 设置页可改；这里的值只是默认`,
    `    headroomTokens: ${DEFAULTS.headroomTokens}`,
    `    reAskRatio: ${DEFAULTS.reAskRatio}`,
    `    timeoutSeconds: ${DEFAULTS.timeoutSeconds}`,
    // 摘要增强是可选项：只在需要时追加这一行，默认不挂
    ...(summarizerEnabled(settings)
      ? [
          '- id: compaction-ask-summary',
          `  name: '${SUMMARY_SPECIFIER}'`,
        ]
      : []),
    '- id: command-compact',
    "  name: '@deepseek-ai/dsh-command-compact'",
    // 还原工具：压缩把原文从「模型可见的 surface」上影子掉，但事件仍留在
    // 会话日志里，所以能原样取回。这一行把取回能力交给模型。
    // 2026-11-25：recover-tool 原先没声明 inject: ['tools']，挂载即抛错，
    // 导致整个 standard 预设校验失败（所有会话「会话不可用」）。已修正后重新挂上。
    '- id: compaction-ask-recover',
    `  name: '${RECOVER_SPECIFIER}'`,
    '- id: tool-result-pruner',
    "  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '  config:',
    '    thresholdChars: 8192',
    '    headChars: 4096',
    '    tailChars: 1024',
  ].map((line) => `${childIndent}${line}`)

  return [...lines.slice(0, childAt), ...children, ...lines.slice(end)]
}

/**
 * 丢掉随包 `skill-filesystem` 的 `customSkillDirs`。
 *
 * 那一行是 `!!js` 表达式，按「补丁文件所在位置」解析
 * `@deepseek-ai/dsh-agent-preset`；在安装目录里成立，从 profile 插件层里
 * 解析不到，抛错会让整个预设激活失败。代价是 standard 会话没有 `dsh-doc`
 * skill（README 里写了怎么加回绝对路径）。
 */
function stripRowConfig(lines, rowId) {
  const rowAt = lines.findIndex((line) => new RegExp(`^(\\s*)- id: ${rowId}\\s*$`).test(line))
  if (rowAt < 0) return lines
  const indent = /^(\s*)/.exec(lines[rowAt])[1].length
  let configAt = -1
  for (let index = rowAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const lineIndent = /^(\s*)/.exec(line)[1].length
    if (lineIndent <= indent) break
    if (lineIndent === indent + 2 && line.trimStart().startsWith('config:')) {
      configAt = index
      break
    }
  }
  if (configAt < 0) return lines
  let end = configAt + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && /^(\s*)/.exec(line)[1].length <= indent + 2) break
    end += 1
  }
  while (end > configAt + 1 && lines[end - 1].trim() === '') end -= 1
  return [...lines.slice(0, configAt), ...lines.slice(end)]
}

/**
 * 生成完整的 cordis.patch.yml 文本。
 *
 * @param shippedText - 随包 `presets/standard.patch.yml` 的全文
 * @param settings - 当前设置（决定要不要挂摘要增强行）；缺省用默认值
 */
export function renderPatch(shippedText, settings = DEFAULTS) {
  let lines = rewriteCompaction(toOverrideRow(shippedText), settings)
  lines = stripRowConfig(lines, 'skill-filesystem')
  const preset = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  const hostRow = [
    '- insert:',
    `    - id: ${PACKAGE_NAME}`,
    `      name: '${PACKAGE_NAME}'`,
  ].join('\n')
  return `${headerText()}\n${hostRow}\n\n${preset}\n`
}

export function snapshotFile(bundleDir) {
  return path.join(bundleDir, 'cordis.patch.yml')
}

/**
 * 比对磁盘快照与当前安装版本。
 * 三个状态：`in-sync` / `drift`（随包预设变了）/ `missing`（快照被删）/
 * `foreign`（不是本工具生成的，例如被手改）。
 */
export async function inspectSnapshot({ bundleDir, dshRoot, env = process.env, settings } = {}) {
  const effective = settings ?? readSettings(resolveDshHome())
  const file = snapshotFile(bundleDir)
  let actual = null
  try {
    actual = await readFile(file, 'utf8')
  } catch {
    return { status: 'missing', path: file, message: '快照文件不存在' }
  }

  let expected
  let source
  try {
    const shipped = await readShippedPreset({ dshRoot, env })
    expected = renderPatch(shipped.text, effective)
    source = shipped.source
  } catch (error) {
    return {
      status: 'unknown',
      path: file,
      message: `读不到随包预设：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (actual === expected) return { status: 'in-sync', path: file, source, message: '与当前安装的 DSH 一致' }
  const generated = actual.startsWith(`# ${PACKAGE_NAME} `)
  return {
    status: generated ? 'drift' : 'foreign',
    path: file,
    source,
    message: generated
      ? '随包 standard 预设与快照不同（通常是 DSH 升级过），点「修复」重新生成'
      : '快照文件不是本插件生成的，点「修复」会按当前 DSH 重写它',
  }
}

/**
 * 重写快照。返回给界面看的结果，成功失败都带一句人话。
 * 快照是组合配置的一层，改写后要重启 DSH 才会被重新读取。
 */
export async function repairSnapshot({ bundleDir, dshRoot, env = process.env, settings } = {}) {
  const effective = settings ?? readSettings(resolveDshHome())
  const file = snapshotFile(bundleDir)
  try {
    const shipped = await readShippedPreset({ dshRoot, env })
    const next = renderPatch(shipped.text, effective)
    let previous = null
    try {
      previous = await readFile(file, 'utf8')
    } catch {
      previous = null
    }
    if (previous === next) {
      return { ok: true, changed: false, path: file, source: shipped.source, message: '快照已经是最新的，没有改动' }
    }
    await writeFile(file, next, 'utf8')
    const version = await readDshVersion({ dshRoot, env })
    return {
      ok: true,
      changed: true,
      path: file,
      source: shipped.source,
      dshVersion: version,
      message: '已按当前安装的 DSH 重新生成快照；重启 DeepSeek Harness 后生效',
    }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      path: file,
      message: `修复失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}