/**
 * 摘要提示词增强逻辑的测试。
 *
 * 这段代码决定「压缩时模型看到什么指令」，改坏的后果是摘要悄悄变差 ——
 * 不报错，只让压缩后命中率下降，很难察觉。所以边界要钉死。
 */

import { COMPACTION_PURPOSE, enhanceStreamOptions, MARKER, PHILOSOPHY, wrapLlm } from '../lib/philosophy.js'

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

const INSTRUCTION =
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.\n\nOutput EXACTLY the Markdown structure below: keep every section, in order.\n\n## Primary Request and Intent\n- [the user's original and evolving goals]\n\n## Current Work\n- [precisely what was in progress]"

function instructionMessage(text = INSTRUCTION) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** 造一份 compaction 调用的 options。 */
function compactionOptions(messages) {
  return { messages, provider: 'p', model: 'm', maxTokens: 4096, purpose: COMPACTION_PURPOSE }
}

// ---- 正常路径：认出指令并追加判据 ----
{
  const real = userMessage('请帮我修这个 bug')
  const instruction = instructionMessage()
  const options = compactionOptions([real, instruction])
  const out = enhanceStreamOptions(options, COMPACTION_PURPOSE)

  check(out !== options, '返回了新对象（不改原值）')
  check(out.messages[0] === real, '真实用户消息原样保留')
  check(out.messages[1].content[0].text.includes(MARKER), '指令后追加了判据')
  check(out.messages[1].content[0].text.startsWith(INSTRUCTION), '原有指令内容保留在前')
  check(out.provider === 'p' && out.model === 'm' && out.maxTokens === 4096, '其余 options 字段不变')
  check(out.purpose === COMPACTION_PURPOSE, 'purpose 保留')
}

// ---- purpose 门控：非 compaction 调用一律不动 ----
{
  const options = compactionOptions([instructionMessage()])
  check(enhanceStreamOptions(options, 'question') === options, 'purpose=question 不增强')
  check(enhanceStreamOptions(options, undefined) === options, 'purpose 缺失不增强')
  check(enhanceStreamOptions(options, 'compaction') !== options, 'purpose=compaction 才增强')
}

// ---- 幂等：已经注入过就不再追加 ----
{
  const options = compactionOptions([instructionMessage()])
  const once = enhanceStreamOptions(options, COMPACTION_PURPOSE)
  const twice = enhanceStreamOptions(once, COMPACTION_PURPOSE)
  check(twice.messages[0].content[0].text.split(MARKER).length - 1 === 1, '重复调用不会二次追加')
  const count = twice.messages[0].content[0].text.split(MARKER).length - 1
  check(count === 1, '判据只出现一次', String(count))
}

// ---- 不误伤：只有开头、没有模板特征的用户消息不该被改 ----
{
  const quoted = userMessage('You are now acting as a compaction engine is not what I said')
  const options = compactionOptions([quoted])
  check(enhanceStreamOptions(options, COMPACTION_PURPOSE) === options, '只引用开头句子的消息不被增强')
}

// ---- 不误伤：用户粘贴的摘要格式（有 ## 小节但不是指令）也不改 ----
{
  const pasted = userMessage('## Primary Request and Intent\n- 这是我的笔记')
  const options = compactionOptions([pasted])
  check(enhanceStreamOptions(options, COMPACTION_PURPOSE) === options, '只有小节的普通消息不被增强')
}

{
  const bothPrefixAndSection = userMessage('You are now acting as a compaction engine\n## Current Work\n随便写的')
  const options = compactionOptions([bothPrefixAndSection])
  check(enhanceStreamOptions(options, COMPACTION_PURPOSE) !== options, '同时有前缀和小节时识别为指令')
}

{
  const unrelated = userMessage('普通消息')
  const options = compactionOptions([unrelated])
  check(enhanceStreamOptions(options, COMPACTION_PURPOSE) === options, '没有那条指令时整体不变')
}

// ---- 结构异常：一律安全返回 ----
{
  check(enhanceStreamOptions(null, COMPACTION_PURPOSE) === null, 'null 原样返回')
  check(enhanceStreamOptions(undefined, COMPACTION_PURPOSE) === undefined, 'undefined 原样返回')
  check(enhanceStreamOptions('x', COMPACTION_PURPOSE) === 'x', '字符串原样返回')
  const noMessages = { provider: 'p', purpose: COMPACTION_PURPOSE }
  check(enhanceStreamOptions(noMessages, COMPACTION_PURPOSE) === noMessages, '没有 messages 原样返回')
  const emptyMessages = { messages: [], purpose: COMPACTION_PURPOSE }
  check(enhanceStreamOptions(emptyMessages, COMPACTION_PURPOSE) === emptyMessages, '空 messages 原样返回')
}

{
  // 非 text block、非 user 角色、坏 content 都不能抛
  const weird = compactionOptions([
    { role: 'assistant', content: [{ type: 'text', text: INSTRUCTION }] },
    { role: 'user', content: [{ type: 'image', url: 'x' }] },
    { role: 'user', content: 'not-an-array' },
    null,
    { role: 'user', content: [null, { type: 'text' }, { type: 'text', text: 123 }] },
  ])
  let threw = false
  try {
    enhanceStreamOptions(weird, COMPACTION_PURPOSE)
  } catch {
    threw = true
  }
  check(!threw, '异常结构不抛错')
}

// ---- 判据内容本身 ----
{
  check(PHILOSOPHY.includes('MUST KEEP'), '判据含 MUST KEEP 段')
  check(PHILOSOPHY.includes('DROP'), '判据含 DROP 段')
  check(PHILOSOPHY.includes('PRIORITY'), '判据含 PRIORITY 段')
  check(PHILOSOPHY.includes('TASK AS OF THIS CHECKPOINT'), '判据含「记录过去」的框架约束')
  check(PHILOSOPHY.length > 1500, '判据内容足够完整（>1500 字符）', String(PHILOSOPHY.length))
}

// ---- off 档：原样透传，一点都不改 ----
{
  const options = compactionOptions([{ role: 'user', content: [{ type: 'text', text: INSTRUCTION }] }])
  const out = enhanceStreamOptions(options, COMPACTION_PURPOSE, 'off')
  check(out === options, 'off 档返回原对象（不注入判据）')
  check(out.messages[0].content[0].text === INSTRUCTION, 'off 档指令文本一字不改')

  // 三档各取一次，确认档位真的改变注入内容
  const lean = enhanceStreamOptions(options, COMPACTION_PURPOSE, 'lean')
  const strict = enhanceStreamOptions(options, COMPACTION_PURPOSE, 'strict')
  check(lean !== options && strict !== options, '非 off 档都会增强')
  check(lean.messages[0].content[0].text !== strict.messages[0].content[0].text, '精简档与严格档注入的判据不同')
  check(strict.messages[0].content[0].text.length > lean.messages[0].content[0].text.length, '严格档判据更长')
}

// ---- wrapLlm：只包 stream，其余转发 ----
{
  const calls = []
  const real = {
    stream(options) {
      calls.push(options)
      return 'streamed'
    },
    resolveModelInfo: () => 'info',
    custom: 42,
  }
  const proxy = wrapLlm(real)
  check(proxy !== real, '返回代理对象')
  check(proxy.resolveModelInfo() === 'info', 'resolveModelInfo 转发正常')
  check(proxy.custom === 42, '自定义属性透传')

  const out = proxy.stream(compactionOptions([instructionMessage()]))
  check(out === 'streamed', 'stream 返回值透传')
  check(calls.length === 1, '真实 stream 被调用一次')
  check(calls[0].messages[0].content[0].text.includes(MARKER), '真实 stream 收到的是增强后的 options')

  // 非 compaction 调用不该被改
  const plain = { messages: [userMessage('你好')], purpose: 'question' }
  proxy.stream(plain)
  check(calls[1].messages[0].content[0].text === '你好', '普通 stream 调用不受影响')
}

{
  check(wrapLlm(null) === null, 'wrapLlm(null) 原样返回')
  const noStream = { resolveModelInfo: () => 1 }
  check(wrapLlm(noStream) === noStream, '没有 stream 的服务原样返回')
}

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS: 摘要提示词增强逻辑正确')
