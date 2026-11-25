// dsh-compaction-ask（压缩询问）的浏览器半侧：设置 → 「压缩询问」一页。
//
// 只做两件事：
//   1. 编辑参数（询问阈值 / 重问增长 / 等待上限），保存到宿主；
//   2. 「修复」按钮：DSH 升级后按当前安装版本重新生成预设快照，成功失败都给提示。
//
// 宿主调用走普通 HTTP 路由（lib/index.js 里的 `ctx.webServer.register`），
// 不用 Remote 服务，因为这里只有几个自定义动作，不需要在 Client 侧声明类型。
//
// 样式全部用 `--dsw-alias-*` 主题变量，深/浅色自动跟随；不 import 任何
// Harness UI 包 —— 那些包会随版本变动，自己写控件最稳。
window.__ModuleLoader__.load({
  id: 'dsh-compaction-ask',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SECTION_ID = 'compaction-ask'
    const ROUTE_PREFIX = '/api/dsh-compaction-ask'

    /**
     * 已知会抢压缩链路的插件。
     *
     * 与服务端 `lib/conflicts.js` 的 `CONFLICTING_PACKAGES` 对应；浏览器模块
     * 不能 import node 侧代码，所以这里内联。只用于显示文案。
     */
    const CONFLICTS = ['billion-context']

    // ---------------------------------------------------------------- 宿主调用

    /** 统一成 {ok, ...}；页面只处理一种形状。 */
    async function callHost(action, payload) {
      try {
        const response = await fetch(`${ROUTE_PREFIX}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        let parsed = null
        try {
          parsed = await response.json()
        } catch {
          parsed = null
        }
        if (parsed === null || typeof parsed !== 'object') {
          return { ok: false, error: `宿主返回了非 JSON 内容（HTTP ${response.status}）` }
        }
        if (!response.ok && parsed.ok !== false) {
          return { ...parsed, ok: false, error: parsed.error ?? `HTTP ${response.status}` }
        }
        return parsed
      } catch (error) {
        return { ok: false, error: `请求失败：${error && error.message ? error.message : String(error)}` }
      }
    }

    // ---------------------------------------------------------------- 小图标

    /** 仪表盘：弧形刻度 + 指针，表示「接近上限」。 */
    function GaugeGlyph({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
      },
        h('path', {
          d: 'M5 17a7.5 7.5 0 1 1 14 0',
          stroke: 'currentColor',
          strokeOpacity: 0.35,
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M5 17a7.5 7.5 0 0 1 5.6-7.25',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 12, cy: 17, r: 1.9, fill: 'currentColor' }),
        h('path', {
          d: 'M15.4 12.6 18 10',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------- 样式

    let styleCache = null
    function pageStyles() {
      if (styleCache !== null) return styleCache
      styleCache = {
        page: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: '100%',
          maxWidth: 640,
          color: 'var(--dsw-alias-label-primary)',
          font: '13px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        },
        head: {
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          columnGap: 10,
          rowGap: 2,
          alignItems: 'center',
        },
        glyph: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          gridRow: 'span 2',
          color: 'var(--dsw-alias-label-primary)',
        },
        title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
        desc: { margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
        card: {
          padding: '14px 16px 16px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
        cardTitle: { margin: '0 0 10px', fontSize: 12.5, fontWeight: 600 },
        row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
        // 二选一的切换按钮 + 旁边「会改变什么」的说明
        switchRow: { display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 12, flexWrap: 'wrap' },
        switchNote: { flex: '1 1 320px', minWidth: 280, fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
        switchNoteTitle: { fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-primary)' },
        switchList: { margin: 0, paddingLeft: 18 },
        field: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 10, alignItems: 'center', padding: '8px 0' },
        fieldLabel: { fontSize: 13 },
        fieldHint: { fontSize: 11.5, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', gridColumn: '1 / -1' },
        inputWrap: { display: 'flex', alignItems: 'center', gap: 6 },
        input: {
          width: 92,
          height: 32,
          padding: '0 8px',
          boxSizing: 'border-box',
          textAlign: 'right',
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 7,
        },
        unit: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', minWidth: 18 },
        buttonPrimary: {
          height: 34,
          padding: '0 18px',
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 8,
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary-foreground)',
          background: 'var(--dsw-alias-button-primary-fill)',
          border: '1px solid transparent',
        },
        buttonGhost: {
          height: 34,
          padding: '0 14px',
          fontSize: 13,
          borderRadius: 8,
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'transparent',
          border: '1px solid var(--dsw-alias-border-l1)',
        },
        buttonBusy: { opacity: 0.7, cursor: 'progress' },
        notice: {
          marginTop: 4,
          padding: '8px 10px',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: 'pre-line',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
        noticeOk: { color: 'var(--dsw-alias-label-primary)' },
        noticeError: { color: 'var(--dsw-alias-status-danger, #d93f3f)' },
        // 红色小字建议：改参数时实时出现，说明「还要同时改什么」
        advisor: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 },
        advisorItem: {
          fontSize: 11.5,
          lineHeight: 1.5,
          color: 'var(--dsw-alias-status-danger, #d93f3f)',
        },
        kv: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12, rowGap: 6, margin: '2px 0 0' },
        kvKey: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
        kvValue: {
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          wordBreak: 'break-all',
          color: 'var(--dsw-alias-label-primary)',
        },
        mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5 },
      }
      return styleCache
    }

    // ---------------------------------------------------------------- 设置页

    function SettingsSection() {
      const { useCallback, useEffect, useMemo, useRef, useState } = React
      const style = useMemo(pageStyles, [])
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [repairing, setRepairing] = useState(false)
      const [switching, setSwitching] = useState(null)
      const [switchResult, setSwitchResult] = useState(null)
      const [notice, setNotice] = useState(null)
      const [repairResult, setRepairResult] = useState(null)
      const aliveRef = useRef(true)

      const applyStatus = useCallback((value) => {
        if (!aliveRef.current) return
        setStatus(value)
        if (value && value.ok && value.settings) {
          setDraft({
            askRatio: String(Math.round(value.settings.askRatio * 100)),
            reAskRatio: String(Math.round(value.settings.reAskRatio * 100)),
            timeoutSeconds: String(value.settings.timeoutSeconds),
            // 策略类字段原样带进 draft：漏掉它们的话下拉框永远是空值，
            // 保存时也提交不出去（这是最容易被忽略的那类 bug）
            compactStrategy: value.settings.compactStrategy ?? 'stock',
            incrementGateTokens: String(value.settings.incrementGateTokens ?? 20000),
            summarizerPolicy: value.settings.summarizerPolicy ?? 'stock',
            retainRatio: String(Math.round((value.settings.retainRatio ?? 0.16) * 100)),
            quality: value.settings.quality ?? 'balanced',
          })
        }
      }, [])

      const refresh = useCallback(async () => {
        const value = await callHost('status', {})
        applyStatus(value)
        return value
      }, [applyStatus])

      useEffect(() => {
        aliveRef.current = true
        void refresh()
        return () => {
          aliveRef.current = false
        }
      }, [refresh])

      const save = async (candidate) => {
        if (saving) return
        setSaving(true)
        setNotice(null)
        const payload = candidate ?? {
          askRatio: Number(draft?.askRatio) / 100,
          reAskRatio: Number(draft?.reAskRatio) / 100,
          timeoutSeconds: Number(draft?.timeoutSeconds),
          compactStrategy: draft?.compactStrategy ?? 'stock',
          incrementGateTokens: Number(draft?.incrementGateTokens),
          retainRatio: Number(draft?.retainRatio) / 100,
          quality: draft?.quality ?? 'balanced',
          // 这个字段界面上没有输入框，但**必须原样回传**：writeSettings 会把
          // USER_FIELDS 全量落盘，不回传就等于每次保存都把它重置成默认值。
          // 它的作用是「quality 之外的强制开关」（见 lib/preset.js）。
          summarizerPolicy: draft?.summarizerPolicy ?? 'stock',
        }
        // 数值字段必须有限；布尔字段（`reset`）与字符串字段（策略）不参与数字校验。
        // 早期版本的坑：`{ reset: true }` 里的 true 不是字符串、Number.isFinite(true)
        // 又是 false，于是「恢复默认」永远弹「「reset」需要一个数字。」
        for (const [key, value] of Object.entries(payload)) {
          if (typeof value === 'string' || typeof value === 'boolean') continue
          if (!Number.isFinite(value)) {
            setSaving(false)
            setNotice({ tone: 'error', text: `「${labelOf(key)}」需要一个数字。` })
            return
          }
        }
        const result = await callHost('settings', payload)
        setSaving(false)
        if (!result || result.ok !== true) {
          setNotice({ tone: 'error', text: (result && (result.error || (result.problems || []).join('；'))) || '保存失败' })
          return
        }
        if (result.settings) applyStatus({ ...(status ?? {}), ok: true, settings: result.settings })
        const corrected = Array.isArray(result.problems) && result.problems.length > 0
        // 恢复默认和「保存当前值」是两件事，提示语要分开 —— 说「已保存」会让人
        // 以为保存了自己填的数，其实是写回了默认值。
        const wasReset = candidate !== null && candidate !== undefined && candidate.reset === true
        setNotice({
          tone: corrected ? 'error' : 'ok',
          text: corrected
            ? `已保存，但有修正：${result.problems.join('；')}`
            : wasReset
              ? '已恢复默认值。下一次模型调用前就按默认参数询问，不需要重启。'
              : '已保存。下一次模型调用前就按新参数询问，不需要重启。',
        })
        void refresh()
      }

      const repair = async () => {
        if (repairing) return
        setRepairing(true)
        setRepairResult(null)
        const result = await callHost('repair', {})
        setRepairing(false)
        setRepairResult(result)
        if (result && result.ok) {
          const value = await callHost('status', {})
          applyStatus(value)
        }
      }

      /**
       * 切换压缩链路归属。
       *
       * 两个按钮走同一个端点，只是 target 不同；服务端负责**互斥**：
       * 启用一个就必然停用另一个。切换后重新拉 status，让上面的
       * 「冲突插件」行立即反映新状态。
       *
       * @param target - `self` 或 `bc`
       */
      const doSwitch = async (target) => {
        if (switching !== null) return
        setSwitching(target)
        setSwitchResult(null)
        const result = await callHost('switch', { target })
        setSwitching(null)
        setSwitchResult(result)
        if (result && result.ok && result.changed) {
          const value = await callHost('status', {})
          applyStatus(value)
        }
      }

      const disabled = status === null || status.ok !== true
      const snapshot = status && status.snapshot ? status.snapshot : null
      const snapshotLabel = snapshot === null
        ? '—'
        : snapshot.status === 'in-sync' ? '已同步'
          : snapshot.status === 'drift' ? '需要修复（随包预设已变化）'
            : snapshot.status === 'missing' ? '快照缺失'
              : snapshot.status === 'foreign' ? '不是本插件生成的'
                : '无法判断'

      // 冲突检测：宿主的 status 路由每次都会现读 profile 清单，
      // 所以这里拿到的永远是最新状态，不需要客户端再发一次请求。
      const conflict = status && status.conflict ? status.conflict : null
      const conflictLabel = conflict === null
        ? '—'
        : conflict.checked !== true ? `无法检测（${conflict.reason ?? '未知原因'}）`
          : conflict.active === true ? `${(conflict.conflicts || []).join('、')} 已启用（会冲突）`
            : conflict.acted === true ? `已自动停用 ${(conflict.removed || []).join('、')}`
              : `未发现（已检查 ${(conflict.packages || []).length} 个已知包）`

      if (status === null) {
        return h('div', { style: style.page }, h('div', { style: Object.assign({}, style.card) }, '正在读取参数…'))
      }

      if (status.ok !== true) {
        return h('div', { style: style.page },
          h('div', { style: style.head },
            h('span', { style: style.glyph }, h(GaugeGlyph, { size: 26 })),
            h('h2', { style: style.title }, '压缩询问'),
            h('p', { style: style.desc }, '读不到宿主路由，插件可能没有启用或宿主版本不匹配。'),
          ),
          h('div', { style: Object.assign({}, style.card) },
            h('div', { style: Object.assign({}, style.notice, style.noticeError) }, status.error || '未知错误'),
            h('div', { style: style.row },
              h('button', { type: 'button', style: style.buttonGhost, onClick: () => void refresh() }, '重试'),
            ),
          ),
        )
      }

      return h('div', { style: style.page },
        // 标题
        h('div', { style: style.head },
          h('span', { style: style.glyph }, h(GaugeGlyph, { size: 26 })),
          h('h2', { style: style.title }, '压缩询问'),
          h('p', { style: style.desc }, '上下文接近上限时先问你，再决定要不要压缩；自动压缩已经关掉。'),
        ),

        // 参数卡
        h('div', { style: style.card },
          h('h3', { style: style.cardTitle }, '参数'),
          draft === null ? h('div', { style: style.kvValue }, '—') : h('div', null,
            field(style, '询问阈值', rangeHint(status, 'askRatio', '上下文用到窗口的多少时弹问题。'), draft.askRatio, (value) => setDraft({ ...draft, askRatio: value }), '%', bounds(status, 'askRatio', { min: 22, max: 95, step: 1 })),
            field(style, '重问增长', rangeHint(status, 'reAskRatio', '答「暂不压缩」后，上下文再涨多少才再问一次。'), draft.reAskRatio, (value) => setDraft({ ...draft, reAskRatio: value }), '%', bounds(status, 'reAskRatio', { min: 1, max: 30, step: 1 })),
            field(style, '等待上限', rangeHint(status, 'timeoutSeconds', '多久不回答就按「暂不压缩」继续；0 表示一直等。'), draft.timeoutSeconds, (value) => setDraft({ ...draft, timeoutSeconds: value }), '秒', bounds(status, 'timeoutSeconds', { min: 0, max: 3600, step: 30 })),
            field(style, '保留比例', '压缩后逐字保留的原文比例。下限 16%（DSH 默认值），不允许更低——低于它摘要要独自承担全部历史。', draft.retainRatio, (value) => setDraft({ ...draft, retainRatio: value }), '%', bounds(status, 'retainRatio', { min: 16, max: 50, step: 1 })),
            select(style, '摘要质量', '决定压缩时对模型下什么指令、以及压缩后按什么标准验收。高质量 = 保留更多锚点与决策理由，摘要也更长。选「关闭」则完全不注入判据，等同 DSH 随包行为。', draft.quality ?? 'balanced', [
              { value: 'off', label: '关闭（不注入判据，用随包指令）' },
              { value: 'lean', label: '精简（只留骨架，最短）' },
              { value: 'balanced', label: '平衡（推荐）' },
              { value: 'strict', label: '严格（锚点与理由最全，最长）' },
            ], (value) => setDraft({ ...draft, quality: value })),
            select(style, '压缩区间策略', '决定「压哪一段」。随包=从尾部保留一截、压掉前面的；BC=只压已消费的增量，保留最近几条和首尾用户消息。', draft.compactStrategy ?? 'stock', [
              { value: 'stock', label: '随包（DSH 默认，尾部保留）' },
              { value: 'bc', label: 'BC（只压已消费增量）' },
            ], (value) => onStrategyChange(draft, value)),
            field(style, '增量门控', 'BC 策略下：上次压缩后新增不足这么多 token 就不压，避免「压了等于没压」。', draft.incrementGateTokens, (value) => setDraft({ ...draft, incrementGateTokens: value }), 'tok', { min: 1000, max: 500000, step: 1000 }),
            advisorBlock(style, advisorHints({
              askRatio: Number(draft.askRatio) / 100,
              retainRatio: Number(draft.retainRatio) / 100,
              quality: draft.quality,
              compactStrategy: draft.compactStrategy,
              incrementGateTokens: Number(draft.incrementGateTokens),
            })),
          ),
          h('div', { style: style.row },
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonPrimary, saving ? style.buttonBusy : null),
              disabled: saving || disabled,
              onClick: () => void save(null),
            }, saving ? '保存中…' : '保存'),
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonGhost, saving ? style.buttonBusy : null),
              disabled: saving || disabled,
              onClick: () => void save({ reset: true }),
            }, '恢复默认'),
            h('span', { style: { flex: 1 } }),
            h('span', { style: style.kvKey }, `引擎门槛 ${Math.round((status.engine?.thresholdRatio ?? 0) * 100)}%（仅放行「现在压缩」）`),
          ),
          h('p', { style: { margin: '8px 0 0', fontSize: 11.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' } },
            `询问阈值的下限随保留比例联动：保留比例 ${Math.round((status.settings?.retainRatio ?? 0.16) * 100)}% 时最低 ${Math.round((status.limits?.askRatio?.min ?? 0.22) * 100)}%（引擎要求「保留比例 < 放行门槛 < 询问阈值」）。设得越低越早问你。`,
          ),
          notice === null ? null : h('div', {
            style: Object.assign({}, style.notice, notice.tone === 'error' ? style.noticeError : style.noticeOk),
          }, notice.text),
        ),

        // 状态与修复卡
        h('div', { style: style.card },
          h('h3', { style: style.cardTitle }, '预设快照'),
          h('p', { style: style.desc },
            '本插件要关掉自动压缩，只能整份覆盖 standard 预设，所以包里带了一份随包预设的快照。',
            'DSH 升级后快照会过时，点「修复」按当前安装版本重新生成，然后重启 DSH。',
          ),
          h('div', { style: style.kv },
            h('span', { style: style.kvKey }, 'DSH 版本'),
            h('span', { style: style.kvValue }, status.dshVersion ?? '未知'),
            h('span', { style: style.kvKey }, '快照状态'),
            h('span', { style: style.kvValue }, snapshotLabel),
            h('span', { style: style.kvKey }, '参数文件'),
            h('span', { style: style.kvValue }, status.settingsPath ?? '—'),
            h('span', { style: style.kvKey }, '快照文件'),
            h('span', { style: style.kvValue }, snapshot ? snapshot.path : '—'),
            h('span', { style: style.kvKey }, '冲突插件'),
            h('span', { style: style.kvValue }, conflictLabel),
          ),
          conflict !== null && conflict.active === true
            ? h('div', { style: Object.assign({}, style.notice, style.noticeError) },
                `检测到 ${(conflict.conflicts || []).join('、')} 同时启用。`
                + '它会把 compaction-basic 整行禁用，本插件就没有可询问的引擎了。'
                + '\n本插件已在启动时把它从 profile.bundles 移除（依赖保留）。重启 DSH 后生效。')
            : null,
          snapshot !== null && snapshot.message && snapshot.status !== 'in-sync'
            ? h('div', { style: Object.assign({}, style.notice, style.noticeError) }, snapshot.message)
            : null,
          h('div', { style: style.row },
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonPrimary, repairing ? style.buttonBusy : null),
              disabled: repairing,
              onClick: () => void repair(),
            }, repairing ? '修复中…' : '修复 / 重新同步'),
            h('button', {
              type: 'button',
              style: style.buttonGhost,
              disabled: repairing,
              onClick: () => void refresh(),
            }, '重新检查'),
          ),
          repairResult === null ? null : h('div', {
            style: Object.assign(
              {},
              style.notice,
              repairResult.ok === true ? style.noticeOk : style.noticeError,
            ),
          },
            repairResult.ok === true
              ? (repairResult.message ?? '修复完成')
                + (repairResult.restartRequired === true ? '（现在请重启 DeepSeek Harness）' : '')
                + (repairResult.path ? `\n写入：${repairResult.path}` : '')
              : `修复失败：${repairResult.error ?? repairResult.message ?? '未知错误'}`,
          ),
        ),

        // 压缩链路归属：二选一
        h('div', { style: style.card },
          h('h3', { style: style.cardTitle }, '压缩链路归属（二选一）'),
          h('p', { style: style.desc },
            '「压缩询问」和 billion-context 抢同一条压缩链路，不能同时启用。',
            '下面两个按钮是互斥的：点哪个就启用哪个，并自动停用另一个。依赖都保留，随时可以切回来。',
          ),

          // 按钮 1：启用本插件
          h('div', { style: style.switchRow },
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonPrimary, switching ? style.buttonBusy : null),
              disabled: switching,
              onClick: () => void doSwitch('self'),
            }, switching === 'self' ? '切换中…' : '启用「压缩询问」'),
            h('div', { style: style.switchNote },
              h('div', { style: style.switchNoteTitle }, '点了会改变什么：'),
              h('ul', { style: style.switchList },
                h('li', null, `把 ${CONFLICTS.join('、')} 从 profile.bundles 移除（依赖保留）`),
                h('li', null, '恢复「上下文接近阈值时先问你」：自动压缩关闭，只有你说压才压'),
                h('li', null, '压缩后原文仍可用 context_recover 完整取回'),
                h('li', null, '需要重启 DSH 生效'),
              ),
            ),
          ),

          // 按钮 2：启用 BC
          h('div', { style: style.switchRow },
            h('button', {
              type: 'button',
              style: Object.assign({}, style.buttonGhost, switching ? style.buttonBusy : null),
              disabled: switching,
              onClick: () => void doSwitch('bc'),
            }, switching === 'bc' ? '切换中…' : '启用 billion-context'),
            h('div', { style: style.switchNote },
              h('div', { style: style.switchNoteTitle }, '点了会改变什么：'),
              h('ul', { style: style.switchList },
                h('li', null, '把 dsh-compaction-ask 从 profile.bundles 移除（依赖保留）'),
                h('li', null, '交出压缩链路：BC 的 gate 会整行禁用 compaction-basic'),
                h('li', null, '**失去**「压前询问」：压缩时机由 BC 自己判断（模型驱动 + 三层门控）'),
                h('li', null, '**失去**本插件的 context_recover / context_search 工具'),
                h('li', null, '换来 BC 的分层折叠（tier-1/2/3）与块级可逆，长会话能力更强'),
                h('li', null, '需要重启 DSH 生效'),
              ),
            ),
          ),

          switchResult === null ? null : h('div', {
            style: Object.assign({}, style.notice, switchResult.ok === true ? style.noticeOk : style.noticeError),
          }, switchResult.ok === true
            ? (switchResult.message ?? '已切换')
            : `切换失败：${switchResult.error ?? '未知错误'}`),
        ),
      )
    }

    /** 一行参数：标签 + 数字输入 + 单位 + 说明。 */
    function field(style, label, hint, value, onChange, unit, range) {
      return h('div', { key: label, style: style.field },
        h('label', { style: style.fieldLabel }, label),
        h('div', { style: style.inputWrap },
          h('input', {
            type: 'number',
            style: style.input,
            value: value,
            min: range.min,
            max: range.max,
            step: range.step,
            onChange: (event) => onChange(event.target.value),
          }),
          h('span', { style: style.unit }, unit),
        ),
        h('span', { style: style.fieldHint }, hint),
      )
    }

    /**
     * 下拉选择项。
     *
     * 只用于「策略」这类枚举值：用 select 而不是输入框，避免手打错字后
     * 被 normalize 静默改回默认（那种「存了却没变」最难查）。
     */
    function select(style, label, hint, value, options, onChange) {
      return h('div', { key: label, style: style.field },
        h('label', { style: style.fieldLabel }, label),
        h('div', { style: style.inputWrap },
          h('select', {
            style: Object.assign({}, style.input, { width: '100%' }),
            value: value,
            onChange: (event) => onChange(event.target.value),
          }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        ),
        h('span', { style: style.fieldHint }, hint),
      )
    }

    /** 用宿主给的范围覆盖本地兜底，避免两边各写一份数字。 */
    function bounds(status, key, fallback) {
      const limit = status && status.limits ? status.limits[key] : undefined
      if (limit === undefined || limit === null) return fallback
      const scale = Number.isFinite(limit.scale) ? limit.scale : 1
      return {
        min: Math.round(limit.min * scale),
        max: Math.round(limit.max * scale),
        step: Number.isFinite(limit.step) ? limit.step : 1,
      }
    }

    function rangeHint(status, key, base) {
      const limit = bounds(status, key, null)
      if (limit === null) return base
      return `${base}（可填 ${limit.min}–${limit.max}）`
    }

    /**
     * 红色提示区块。
     *
     * 任务 5 选的是这个方案：**改参数时实时出红色小字**，而不是在参数上加
     * 一段静态推荐。静态推荐改完就过期，实时提示能跟着当前草稿算。
     */
    function advisorBlock(style, hints) {
      if (!Array.isArray(hints) || hints.length === 0) return null
      return h('div', { key: 'advisor', style: style.advisor },
        ...hints.map((hint, index) => h('div', { key: index, style: style.advisorItem }, `⚠ ${hint.text}`)))
    }

    /**
     * 切换压缩策略时**直接改参数**（任务 4）。
     *
     * 不是只改一个字符串：每个策略有各自的合理区间，切换时把整套参数调到
     * 该策略的推荐值，同时不突破硬下限（保留比例 ≥16%、阈值 ≥ 保留比例+6%）。
     */
    function onStrategyChange(draft, strategy) {
      const retain = Math.max(16, Number(draft.retainRatio) || 16)
      const askFloor = Math.round(retain + 6)
      const next = { ...draft, compactStrategy: strategy, retainRatio: String(retain) }

      if (strategy === 'bc') {
        // BC 要压大段历史：门控不能太低，质量不应低于平衡
        next.incrementGateTokens = String(Math.max(20000, Number(draft.incrementGateTokens) || 0))
        if (draft.quality === 'lean') next.quality = 'balanced'
      } else {
        next.incrementGateTokens = '20000'
      }

      if (Number(next.askRatio) < askFloor) next.askRatio = String(askFloor)
      setDraft(next)
    }

    /**
     * 「建议同时改什么」——与服务端 `lib/quality.js` 的 `advisorHints` 同规则。
     *
     * 浏览器模块不能 import node 侧代码，所以这里内联一份。两边算法必须一致；
     * 不一致只会导致提示文案不同，不会影响保存结果（保存时以服务端为准）。
     */
    function advisorHints(d) {
      const hints = []
      const retain = d.retainRatio
      const ask = d.askRatio
      const quality = d.quality ?? 'balanced'
      const strategy = d.compactStrategy ?? 'stock'
      const gate = d.incrementGateTokens

      if (Number.isFinite(retain) && retain <= 0.24 && quality === 'lean') {
        hints.push({ text: '保留比例偏低时「精简」质量容易丢细节，建议至少改成「平衡」' })
      }
      if (Number.isFinite(retain) && Number.isFinite(ask) && ask < retain + 0.06 - 1e-9) {
        hints.push({ text: `询问阈值低于保留比例 ${Math.round(retain * 100)}% 允许的下限 ${Math.round((retain + 0.06) * 100)}%，保存时会自动提高` })
      }
      if (strategy === 'bc' && Number.isFinite(gate) && gate < 10000) {
        hints.push({ text: 'BC 策略下增量门控低于 10000 会压得太频繁，建议 ≥ 20000' })
      }
      if (strategy === 'bc' && quality === 'lean') {
        hints.push({ text: 'BC 会压掉大段历史，配合「精简」质量容易丢细节，建议至少「平衡」' })
      }
      if (quality === 'strict' && Number.isFinite(retain) && retain < 0.2) {
        hints.push({ text: '「严格」质量需要保留比例 ≥ 20%，否则摘要没有足够原文支撑' })
      }
      return hints
    }

    function labelOf(key) {
      return key === 'askRatio' ? '询问阈值'
        : key === 'reAskRatio' ? '重问增长'
        : key === 'timeoutSeconds' ? '等待上限'
        : key === 'incrementGateTokens' ? '增量门控'
        : key === 'compactStrategy' ? '压缩区间策略'
        : key === 'summarizerPolicy' ? '摘要策略'
        : key === 'retainRatio' ? '保留比例'
        : key === 'quality' ? '摘要质量'
        : key
    }

    // ---------------------------------------------------------------- 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 45,
          label: () => '压缩询问',
        }, SettingsSection))

        // 导航图标按 id 派发，两处 id 必须逐字相同
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: SECTION_ID,
        }, (props) => h(GaugeGlyph, { size: props && props.size ? props.size : 16 })))
      },
    }
  },
})