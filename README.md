# dsh-compaction-ask（压缩询问）

上下文快满时**先问你**，而不是自动压缩。

- `@deepseek-ai/dsh-compaction-basic` 的 `auto` 被关掉：DSH 不再自己压缩历史。
- 上下文用到设定阈值（默认 **60%**）时弹一个三选一的问题：
  - **现在压缩** —— 把较早的历史总结成一条摘要后继续本轮请求（多一次模型调用）。
  - **暂不压缩** —— 先不压缩，上下文再涨「重问增长」（默认 5%）才会再问一次。
  - **本会话不再询问** —— 本会话不再弹窗，需要时手动 `/compact`。
- 到「等待上限」（默认 300 秒）不回答按「暂不压缩」继续，不会卡住这一轮。
- `compaction-basic` 的 `thresholdRatio`（0.18）和 `retainRatio`（0.16）是「你同意后才放行」的引擎门槛，不触发任何自动压缩。引擎要求 `retainRatio < thresholdRatio`，且执行时当前用量必须不低于 `thresholdTokens`，否则会出现「问了、你点了压缩、引擎却不干」。因此**询问阈值最低 22%**（保留比例 16% 是 DSH 默认值，不允许更低）。
- 询问框会告诉你**这次大约能腾出多少、会留下多少原文**；正在使用的最近 5 条消息永远不压。
- 压缩后的原文**可以用 `context_recover` 完整取回**（保真 100%），这是本插件与 BC 最大的不同。

## 借用的思想（溯源）

来自 **[billion-context](https://github.com/ranxianglei/billion-context)**（MIT，作者 Xianglei Ran / 冉祥磊）。**不含其任何代码**，只借概念，各自重新实现：

| 借了什么 | 来自哪里 | 本插件怎么用 |
| --- | --- | --- |
| **保护区**：近期消息永不压缩 | 论文 §3.3 «保护区与过滤器»（内核 filter 阶段强制） | `lib/bc-strategy.js` 的 `PROTECT_RECENT_MESSAGES = 5` |
| **只压已消费的增量** | 论文 §3.4 «需求侧触发：增速门控»（50K 增长下限、有效下限 22.5K） | `incrementTokens()` + `incrementGateTokens()` |
| **KEEP VERBATIM / DROP / PRIORITY 三段判据** | 论文 §4 «压缩哲学»；源码常量 `HOW_TO_COMPRESS_RULES`（6,420 字符） | `lib/quality-rules.js` 的 `HARD_KEEP` / `DROP_*` / `PRIORITY_*` |
| **「摘要记录的是过去」框架** | 同上 `FRAMING` 段；源码里的 `TASK AS OF THIS BLOCK` | `lib/quality-rules.js` 的 `FRAMING` |
| **摘要工艺：为丢弃项写一行内容说明** | 同上："For each significant item you DROP, add a one-line CONTENT description" | `DROP_BALANCED` 末段 |
| **两条硬性保留**：路径带行号、错误串逐字 | 同上 `KEEP VERBATIM` 前两条 | `HARD_KEEP` |

**BC 没有的东西（本插件自己加的）**：

- **质量分级**：BC 源码里 `summaryQuality` / `qualityLevel` / `compressionLevel` 出现次数都是 0，它的 tier-1/2/3 是**压缩层级**（压摘要本身）而非质量档位。本插件把判据拆成 **off / lean / balanced / strict 四档**，每档用不同的 KEEP 强度与 DROP 容忍度（`lib/quality-rules.js`），并且**压缩后会按档位验收产物**（`lib/summarizer.js` 的 `verifySummary` → `guard.js` 的 `verifyAfterCompaction`）。
- **压缩后验收**：BC 靠模型自觉，本插件用 `lib/quality.js` 的 `scoreSummary()` 量化核对（锚点覆盖率、理由标记、结构、密度、预算）。
- **原文可还原**：BC 靠块谱系 `decompress`；本插件直接读 DSH 会话日志的 `shadowedSeqs`，保真度 100%（`lib/recover.js`）。

## 压缩区间策略：BC（可选）

DSH 随包引擎按「尾部保留」选区间：从最后一条往前累加到 `retainRatio × 预算`，把前面全部压掉。BC 的策略不同——**只压已消费的增量**。

设置页「压缩区间策略」可以直接切换，改完下一次询问即生效，不用重启：

| 策略 | 选区间方式 | 增量门 |
| --- | --- | --- |
| `stock`（默认） | 尾部保留 `retainTokens`，其余全压 | 无 |
| `bc` | 同上，但**额外要求**：上次压缩以来新增 ≥ `增量门控`，否则不压 | 有 |

保护区（两套策略共用，硬编码）：system prompt、第一条用户消息、最后一条用户消息、最近 5 条消息，永远不进压缩区间。

**实现上只替换「选哪段」**：算好 `start`/`end` 后调 `compaction-basic` 的 `compactRegion()`。工具配对平衡、`compaction/start`/`compaction/summary` 事件写入、surface 替换、并发锁全部复用原实现——重写这些的收益远小于风险。

### 一句实话：BC 在 DSH 里能发挥多少

**单次压缩，BC 和随包策略结果几乎一样。** 这不是实现不到位，是 DSH 的数据模型决定的：压缩只能是「一段连续区间换成一条摘要」，两者的上界都是「system 之后、保护区之前」，自然重合。

BC 真正的差异在**跨轮行为**，而这一层 DSH 撑不住：

| BC 机制 | DSH 能否承载 |
| --- | --- |
| 增量门控（没新增就不压） | ✅ 已实现 |
| 保护区 | ✅ 已实现 |
| 只压已消费增量 | ✅ 已实现（旧摘要不再被二次压缩，见下） |
| 分层蒸馏 tier-1/2/3 | ❌ DSH 没有块概念，摘要不能引用摘要 |
| 块级可恢复（解压回原文） | ⚠️ BC 靠块谱系、有磨损；本插件直接读日志，保真 100% |
| 模型自己决定压什么 | ❌ 区间由代码算，模型只写摘要 |

**旧摘要不会被二次压缩**：`lib/bc-strategy.js` 的 `selectCompactSpan` 把起点定在最后一个 `compact-checkpoint` 之后。DSH 默认行为是把旧摘要一起再压一遍 —— 实测信息留存率约 38%/轮（与 BC 论文报的 ρ≈0.4–0.6 吻合），7 轮后只剩 0.11%。开 `bc` 策略就没有这个复合衰减。

所以**不要期待「装了就有 BC 的效果」**。BC 的省 token 和命中率来自它那套 10k 行内核（分层 + 可逆 + 模型决策），DSH 的压缩接口只开放了「写摘要」和「我能自己算区间」这两件事。

如果你的目标是「尽量像 BC」，能走到的终点是：`compactStrategy: bc` + `quality: strict`。这两个都打开，就是这套架构的上限了。

## 被压缩的内容可以找回来

**DSH 的压缩本来就是可逆的**，只是没给模型提供读回来的手段。

压缩在 DSH 里是 `surfaceOp: replace` —— 只在**模型可见的上下文**里把那一段影子掉，原始事件完整留在会话日志中。源码注释写得很明白：

> The model-visible surface deliberately shadows replaced ranges... Append-origin events are that transcript's durable source material.

所以本插件提供两个只读工具，把它们找回来：

| 工具 | 作用 |
| --- | --- |
| `context_recover` | 还原某次压缩的原文（`index` 指定第几次，不填取最近一次；`list_only` 列出全部记录） |
| `context_search` | 在被压缩的历史里按关键词搜片段，比整体还原省 |

实测你当前这个会话：两次压缩共影子掉 378 条事件，`context_recover` 能逐字取回 250/250 条原文——**保真度 100%，不像摘要那样有磨损**。

### 命令行（不开 DSH 也能用）

```bash
cd F:\DeepseekHarnessWorkSpace\DSHdev\dsh-compaction-ask

# 1. 先看这个会话压缩过几次
node tools/recover.mjs "C:\Users\你似晚霞愈晚愈浓\.dsh\sessions\--F-DeepseekHarnessWorkSpace-DSHdev--\session-40f87ea4-3c73-458a-99f6-3751829bd62d\session.v4.jsonl.zstd"

# 2. 还原第 1 次到文件
node tools/recover.mjs <同一路径> --index 1 -o history-1.md

# 3. 搜关键词，只出片段
node tools/recover.mjs <同一路径> --search retainRatio --limit 5
```

路径也可以给**会话目录**（自动找里面的日志），或者干脆省略——用 `$DSH_SESSION_ID` 推断当前会话：

```bash
node tools/recover.mjs --list
```

完整选项见 `node tools/recover.mjs --help`。

> `-o` 省略时直接打印到终端。单次还原有 20 万字符上限（防止把 11 MB 原文一次倒出来），超出会提示「只返回了前 N 条」。

### 用法举例（模型的视角）

> 「之前那个 retainRatio 的报错原文是什么？」→ 模型调 `context_search(query: "retainRatio")` → 命中片段 → 需要全文再 `context_recover(index: 1)`。

**只读，不写回**：还原出来的内容只作为工具结果给模型看，不撤销压缩、不改 surface。撤销会破坏 `compaction/summary` 的记账，不该由工具做。

这一条比 BC 的做法更彻底：BC 的 `decompress` 依赖它自己维护的块谱系，DSH 有完整日志，所以能按 `shadowedSeqs` 精确复原，且不受摘要质量影响。

## 更好的摘要

压缩时给模型的指令，DSH 随包版本只说了「要哪些小节」，**没说什么必须逐字保留、什么可以丢、空间不够时先保什么** —— 这三件恰恰决定压缩后的命中率。本插件在摘要调用的指令后面追加一段判据（KEEP VERBATIM / DROP / PRIORITY），思路来自 billion-context。

**怎么开**：设置页 →「摘要质量」选 **精简 / 平衡 / 严格** 任一项即可，保存后**下一次摘要就生效**（判据是运行时现读的，不用重启）。

要让判据真正进入压缩链路，预设快照里需要有 `compaction-ask-summary` 这一行。`quality` 不是 `off` 时它会自动挂上；改完 `quality` 后如果快照是旧的，点一次「修复 / 重新同步」并重启：

```bash
node tools/sync-preset.mjs    # 重新生成快照，然后重启 DSH
node tools/sync-preset.mjs --check   # 只检查（过时退出码 2）
```

`compaction-basic` 本身仍是随包原版，没有替换。

**为什么状态存设置文件而不是环境变量**：设置页的「修复」按钮也在生成快照，但它运行时读不到你 shell 里的环境变量 —— 那样按一次修复就会把功能悄悄关掉。

**实现要点**：随包引擎调 `ctx.llm.stream()` 时会带 `purpose: "compaction"`，本插件监听 cordis 的 `internal/get`，只给这一次调用包一层，其它调用（普通对话、子 agent、标题生成）一律原样透传。不 import 任何 `@deepseek-ai/*` —— 那些是 asar 内置包，插件目录解析不到，一个 `ERR_MODULE_NOT_FOUND` 会让整个预设激活失败。

**代价**：判据是英文、1.7–2.3K 字符（按档位），每次摘要调用都会进输入。摘要本身只发生一次，相对省下的历史 token 可以忽略，但它确实增加了那一次调用的成本。

## 摘要质量分级（四档）

BC 只有一套固定的压缩哲学（外加 tier-1/2/3 三个**压缩层级**，那是「压摘要本身」，不是质量档位）。本插件把它拆成四档，**同时作用于三处**——只改 UI 不改行为就是假的：

1. **发给模型的指令**（`lib/quality-rules.js`）——决定模型往哪个方向写；
2. **压缩后的验收门槛**（`lib/quality.js` 的 `scoreSummary`）——决定产物是否算合格；
3. **压缩后的实际验收**（`guard.js` 的 `verifyAfterCompaction`）——压缩成功后拿产物对照档位打分，不合格记一条 warn。

| 档位 | KEEP 强度 | DROP 容忍度 | 预算 | 验收要求 |
| --- | --- | --- | --- | --- |
| **关闭 `off`** | 不注入任何判据 | — | — | 不验收（等同 DSH 随包行为） |
| 精简 `lean` | 只留硬性项 | 激进丢弃 | 原文 ≤11% | 锚点 ≥25%、密度 ≥0.8 |
| 平衡 `balanced` | 硬性项 + 决策理由 | BC 原版平衡点 | ≤19% | 锚点 ≥30%、密度 ≥1.2、结构与未完成事项 |
| 严格 `strict` | 硬性项 + 理由 + 被否决方案 + 数值证据 | 只丢无信息量的 | ≤34% | 锚点 ≥33%、密度 ≥1.6、全项 |

**`off` 是真的关**：`qualityRules('off')` 返回空串，`enhanceStreamOptions` 直接原样透传（一个字节都不改），验收也跳过。它存在的理由很实际——只有三个「都带判据」的档位时，想用随包指令的人没有退路。切策略时也**不会**把 `off` 悄悄改成 `balanced`：那是在违背一个明确的意愿。

### 怎么判断摘要质量（可量化，不靠感觉）

ROUGE 那类指标需要参考摘要，这里没有参考，所以走**可检查属性**（deterministic contract checks），不需要额外调模型：

| 指标 | 怎么算 | 为什么重要 |
| --- | --- | --- |
| **锚点覆盖率** | 从原文「散文部分」抽文件路径/错误码/版本号/反引号标识符，看有多少进了摘要 | BC 头号 KEEP 规则；丢了就没法 grep 回去 |
| **决策理由** | 数 `because` / `因为` / `而不是` / `否则` 等标记 | 没有理由的决策等于没有决策 |
| **结构完整** | 命中几个 DSH 标准小节 | 结构塌了说明模型没遵守模板 |
| **未完成事项** | 是否有 `Open objectives` / `待办` 等 | 丢了就是任务失踪 |
| **信息密度** | 每千字摘要有多少锚点 + 理由标记 | 太稀说明废话多 |
| **体积预算** | 摘要字数 / 原文总字数 | 防止「质量高」变成「什么都留」 |

**只从散文里算锚点**：实测一份 2MB 原文里，光 `ls -R` 的输出就贡献 484 个 `.js` 路径。把它们算成「必须保留的锚点」会让任何摘要都不合格。BC 的判据本来就区分 KEEP（散文、错误串）与 DROP（工具输出），所以锚点只从散文抽。

### 实测验证：档位真的改变摘要

用同一份 30,000 字真实对话，三个独立 agent 按三档规则各写一份（`off` 档不注入判据，所以不在对照里）：

| 档位 | 摘要字数 | 占原文 | 锚点覆盖率 | 理由标记 | 信息密度 |
| --- | --- | --- | --- | --- | --- |
| lean | 2,762 | 9.2% | 30% | 0 | 10.9 |
| balanced | 4,639 | 15.5% | 33% | 0 | 8.8 |
| strict | 8,427 | 28.1% | **37%** | **3** | 7.7 |

结论：**字数 3 倍差、锚点率单调上升、理由标记只在 strict 出现**。档位是真实约束，不是装饰。上表的验收门槛就是按这次实测标定的（实测值上浮约 20% 作为容忍余量）。

## 设置页

**设置 → 压缩询问**（DSH 设置对话框左侧导航里的一节）：

| 项 | 默认 | 作用 |
| --- | --- | --- |
| 询问阈值 | 60% | 上下文用到窗口的多少时弹问题（**下限随保留比例联动**，最低 22%） |
| 重问增长 | 5% | 答「暂不压缩」后，上下文再涨多少才再问（范围 1–30%）。这个值同时决定增量门：可压缩量不到它的一半时干脆不问 |
| 等待上限 | 300 秒 | 多久不回答就继续；0 表示一直等（范围 0–3600） |
| **保留比例** | **16%** | 压缩后逐字保留的原文比例。**下限 16%（DSH 默认值），不允许更低** |
| **摘要质量** | **平衡** | 关闭 / 精简 / 平衡 / 严格，详见上一节。**严格档要求保留比例 ≥20%** |
| **压缩区间策略** | **随包** | 随包=尾部保留；BC=只压已消费增量。**切换时自动调整门控、质量、阈值** |
| 增量门控 | 20000 tok | BC 策略下新增不足此量就不压 |

### 联动规则（会真的改你的数字）

| 你改什么 | 会发生什么 | 为什么 |
| --- | --- | --- |
| 保留比例 → 16% | 询问阈值下限锁到 **22%**；若当前阈值更低会被自动抬到 22% | 引擎要求 `retainRatio < thresholdRatio < askRatio`，链条是 16% < 18% < 22% |
| 保留比例 → 30% | 询问阈值下限升到 **36%** | 同上，公式是 `retainRatio + 6%` |
| 保留比例 → 5% | 被抬回 **16%** | 16% 是 DSH 默认值，不允许更低 |
| 摘要质量 → 严格 | 保留比例下限升到 **20%** | 摘要更长，需要更大的原文窗口支撑 |
| 区间策略 → BC | 门控抬到 ≥20000；质量从「精简」抬到「平衡」（`off` 不动）；阈值不低于联动下限 | BC 会压掉大段历史，参数要跟上 |

每一次联动都会在保存后给出**一句解释**，不是静默改数字。

### 红色提示：改参数时告诉你还要改什么

界面在你改参数时**实时**在下方显示红色小字，指出当前组合还差什么（而不是在参数上加一段死的推荐文字——那种改完就过期）：

- 保留比例偏低 + 质量「精简」→ 建议至少「平衡」
- BC 策略 + 增量门控 < 10000 → 建议 ≥20000
- 阈值低于联动下限 → 提示保存时会自动提高
- 质量「严格」+ 保留比例 < 20% → 提示没有足够原文支撑

默认组合（16% + 平衡 + 随包）**不会报警**——天天报红会让所有警告都失去意义。

点**保存**写进 `%USERPROFILE%\.dsh\compaction-ask\settings.json`，**下一次模型调用前就生效，不需要重启**。超出范围的值会被夹到边界并在页面上说明；**恢复默认**把所有字段一起写回默认（保留比例回到 16%、质量回到平衡）。

文件里只存用户字段（不再包含 `headroomTokens`，它由插件内置）。触发点还受一个内置的 `headroomTokens`（16384）影响：

```
触发阈值 = min(窗口 × 询问阈值, 窗口 − 输出预留 − headroomTokens)
```

取 16384 是为了让 32K 这类小窗口模型也能按你设的比例触发（早先取 65536 时，窗口 ≤64K 根本不会触发，100K 窗口会提前到约 30%）。这个值不开放编辑，也不再读文件里的旧值——早期版本写进文件的 65536 会在升级后悄悄改变触发点，现在会被忽略并在页面上提示一次。**16K 窗口的模型会被它卡死**（`窗口 − 输出预留 − 16384 ≤ 0`，连询问都不会发生），真要用 16K 模型需要改 `lib/settings.js` 把 `ENGINE.headroomTokens` 降到 4096 左右。

同一页还有**修复 / 重新同步**按钮和快照状态，见下一节。

## 「修复」是干什么的（DSH 升级之后用）

DSH 的自动压缩开关是 `standard` 预设里 `compaction-basic` 那一行的配置，而预设配置只能**整份替换**、不能局部合并。所以本包带了一份「随包 standard 预设的快照 + 压缩组两处改动」写在自己的 `cordis.patch.yml` 里。

这份快照会随 DSH 升级而过时。设置页的「预设快照」区块会显示：

- **DSH 版本**、快照文件路径；
- **快照状态**：`已同步` / `需要修复（随包预设已变化）` / `快照缺失` / `不是本插件生成的`。

状态不是「已同步」时点**修复 / 重新同步**：插件会从当前安装的 `app.asar` 读出随包的 `presets/standard.patch.yml`，重新生成快照并写回，页面就地显示成功或失败（失败会带原因）。成功且确有改动时，页面提示**重启 DeepSeek Harness**——快照属于组合配置的一层，只在启动/重新组合时读取。

也就是说：**升级 DSH 之后不需要记任何命令**，打开设置页点一下按钮即可。命令行等价物（排查时用）：

```bash
node tools/sync-preset.mjs            # 重新生成
node tools/sync-preset.mjs --check    # 只检查是否过时（过时退出码 2）
```

注意：从本地目录安装时，profile 里可能是**副本**而不是链接；此时命令行的 `sync` 改的是工作区这份，要让已装的那份生效请用设置页的按钮（它写的是正在运行的安装目录）。

## 安装

**Plugins → 添加插件** → 填这个目录的绝对路径 → **安装** → **立即启用**，然后开**新会话**验证（已有会话沿用启动时的插件版本）。

装完打开 **设置 → 压缩询问**：页面能读到参数、快照显示「已同步」，就说明宿主行和客户端都挂上了。

## 从旧的手工配置迁移

如果 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）里还留着一条 `- id: preset-standard` 覆盖，它是优先级更高的配置层，会**盖住本包的补丁**——插件装上了、设置页也在，但压缩行为还走旧的那份配置。

装上本包后要把那一段删掉（删前备份该文件），重启后开新会话，确认 60% 的弹窗来自插件本身。旧做法留下的 `plugins/compaction-ask/` 目录随后可以删掉。

## 卸载 / 回滚

在 Plugins 里移除本包，DSH 回到随包默认行为（自动压缩）。手动 `/compact` 一直可用。

## 搬动会话到别的工作区

`tools/migrate-session.mjs` 处理「把某个会话从一个工作区挪到另一个」。DSH 把会话固化在
`$DSH_HOME/sessions/<工作区键>/<会话 id>/`，日志第一行还硬编码了 `cwd`，工作区注册表
`storages/workspace.json` 也各自维护 `sessionIds`——三处必须一起改。

```bash
# 单个会话
node tools/migrate-session.mjs --session <id> --to "F:\DeepseekHarnessWorkSpace\DSHdev" --dry-run
node tools/migrate-session.mjs --session <id> --to "F:\DeepseekHarnessWorkSpace\DSHdev"

# 整个工作区（含 subagent 子会话）
node tools/migrate-session.mjs --all-from "F:\DeepseekHarnessWorkSpace\MSdev" --to "F:\DeepseekHarnessWorkSpace\DSHdev"

# 回滚
node tools/migrate-session.mjs --restore "<备份目录>"
```

先 `--dry-run` 看路径，去掉它才真正执行。约束与行为：

- 会话日志被占用时拒绝执行（DSH 正在写它）；所以要在重启后、那个会话没打开时搬。
- 移动前把整份会话目录与 `workspace.json` 备份到
  `$DSH_HOME/compaction-ask/session-move-backups/<时间戳>/`，`--restore` 用它回滚。
- **只改第一行 `cwd`，并保住 zstd 帧边界**：会话日志是「多帧拼接」，DSH 要求**第一帧恰好只有
  header 一行**（`assertIndependentHeaderFrame`）。所以只重压第一帧，其余帧按原始字节拼接——
  把整份日志解压后一次性重压是错的（见下面的「已知故障」）。
- 目标工作区必须已经在 DSH 里打开过一次（否则注册表里没有它，脚本会拒绝并提示）。
- **subagent 子会话**（id 不带 `session-` 前缀、header 里带 `parentSession`）不进工作区注册表，
  它们靠跟父会话的关系被找到；脚本会一并搬目录、改 `cwd`，但不动 `sessionIds`。
- **`--bridge`**：正在运行的会话把日志路径缓存进内存，直接删旧目录会让它继续往旧路径写、把会话
  拆成两半。这个开关在旧位置留一个指向新目录的 junction，写入照常落到新文件；重启该 junction
  即可删除（它没有副作用，只是残影）。
- 任一步失败自动回滚。

### 已知故障：搬完会话从侧边栏消失（已修）

早期版本的 `rewriteHeader` 把整份日志解压后一次性 `zstdCompressSync` 重压，得到**一个**大帧。
DSH 读取时 `assertIndependentHeaderFrame` 要求第一帧恰好一行 header，不满足就抛错，
`list()` 跳过该会话 → 工作区拿不到它的 header → **整个工作区看起来是空的**。
另外 `--restore` 也会把这个坏文件还原回去，所以别用它回滚这个故障。

诊断与修复（`DSH_HOME` 默认 `%USERPROFILE%\.dsh`）：

```bash
node tools/repair-session-logs.mjs            # 只检查
node tools/repair-session-logs.mjs --apply    # 从备份还原原生帧，只重写首行 cwd
```

脚本从 `session-move-backups/` 里的原始备份重建（备份是原生多帧结构），
只重压第一帧、其余帧字节原样保留，写前先存 `.bak-<时间戳>`，并核对重建后行数一致。
前提是备份还在——**备份被删除后无法还原帧结构**，只剩解压重写一条路。

`tools/migrate-session-test.mjs` 是这个故障的回归测试（不需要 DSH）。


## 已知取舍

随包预设里 `skill-filesystem` 的 `customSkillDirs` 用了一行 `!!js` 表达式，按「补丁文件所在位置」解析 `@deepseek-ai/dsh-agent-preset`。它在安装目录里成立，但从 profile 插件层里解析不到，抛错会让整个预设激活失败，所以快照里**省略了这一段**：standard 会话不再提供 `dsh-doc` skill。

需要的话，在 `cordis.patch.yml` 的 `skill-filesystem` 行下加回绝对路径（之后每次「修复」都会把它覆盖掉，所以更稳的做法是改 `lib/preset.js`）：

```yaml
      - id: skill-filesystem
        name: '@deepseek-ai/dsh-skill-filesystem'
        config:
          customSkillDirs:
            - 'D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills'
```

## 往预设里加行之前，必须读这一条

**预设里的每一行都是「一票否决」单元。** 它 `apply` 阶段抛任何异常，代价不是「少一个功能」，而是**整个 standard 预设校验失败、该预设下所有会话不可用**（标题退化成 `session-<uuid>`、输入框显示「会话不可用」）。

真实事故（2026-11-25）：`lib/recover-tool.js` 写了 `ctx.tools` 却没声明 `export const inject = ['tools']`。cordis 在未声明注入时取值即抛，于是这一行 `not started`，所有会话报废。当时 8 套测试全绿——因为它们**只测纯逻辑模块，从不加载会被 DSH 挂载的入口文件**。

现在有 `tools/row-startup-test.mjs` 挡这个洞：它把快照里每个 `dsh-compaction-ask/*` 行真实 import 一遍，用假 ctx 调 `apply`，并静态核对 `ctx.<service>` 裸访问是否都在 `inject` 里（`logger` 除外——它是 context 自带成员，DSH 里 87 个官方包用它，没有一个写进 inject）。

写新行时记住两条：

1. 用 `ctx.get('service')` 就安全（`guard.js` 全程这么写）；
2. 用 `ctx.service` 就必须同时写 `export const inject = ['service']`。

## 开发

```bash
node tools/range-test.mjs        # 保护区与可压缩量估算
node tools/bc-strategy-test.mjs  # BC 区间选择
node tools/recover-test.mjs      # 原文还原与搜索
node tools/quality-test.mjs      # 质量分级 / 比例联动 / 建议提示 / 策略切换
node tools/conflicts-test.mjs    # 冲突检测与自动让路
node tools/philosophy-test.mjs   # 摘要提示词增强（含 off 档短路）
node tools/row-startup-test.mjs  # 预设行启动自检（防「一票否决」）
node tools/smoke.mjs             # 守护逻辑
node tools/routes-test.mjs       # 宿主路由
node tools/client-test.mjs       # 客户端模块注册

npm test                         # 全部一起跑（10 套）
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/guard.js` | 守护行（挂在预设的 compaction 组里）：量上下文、问人、按需压缩、压缩后按档位验收。零第三方依赖，任何失败都放行本轮。 |
| `lib/range.js` | 保护区与可压缩量估算（纯计算）：最近 5 条不压、只压增量、问题里的真实尺寸。 |
| `lib/bc-strategy.js` | BC 式区间选择：保护区、增量门控、首尾用户消息保护、旧摘要不被二次压缩。 |
| `lib/quality.js` | 质量四档定义（含 off）、量化打分（锚点/理由/结构/密度/预算）、联动建议、策略默认值。 |
| `lib/quality-rules.js` | 按档位生成摘要判据（KEEP/DROP/PRIORITY 分档，`off` 返回空串，溯源见 README 顶部）。 |
| `lib/conflicts.js` | 检测并自动停用会抢压缩链路的插件（BC），支持双向切换。 |
| `lib/recover.js` | 从会话日志还原被压缩的原文（纯计算，可单测）。 |
| `lib/recover-tool.js` | 把还原能力注册成模型可调用的 `context_recover` / `context_search`。 |
| `lib/philosophy.js` | 摘要判据与 `llm.stream` 包装（纯计算，可单测）。 |
| `lib/summarizer.js` | 摘要增强行：监听 `internal/get`，只增强 `purpose: compaction` 的调用；`verifySummary` 供验收。 |
| `lib/index.js` | 宿主行：`/api/dsh-compaction-ask/{status,settings,repair,conflicts,switch}` 五条本机路由。 |
| `lib/settings.js` | 参数默认值、范围、联动公式、读写与夹紧。 |
| `lib/preset.js` | 读取随包预设、生成快照、比对状态、执行修复。 |
| `lib/client.js` | 设置页（`settings.section` + 导航图标）。 |
| `cordis.patch.yml` | 生成物：插入宿主行 + 覆盖 `standard` 预设。不要手改。 |
| `tools/range-test.mjs` | `range.js` 的单元测试。 |
| `tools/bc-strategy-test.mjs` | BC 区间选择的单元测试。 |
| `tools/recover-test.mjs` | 原文还原与搜索的单元测试。 |
| `tools/quality-test.mjs` | 质量分级、比例联动、建议提示、策略切换的单元测试。 |
| `tools/conflicts-test.mjs` | 冲突检测与自动让路、双向切换的单元测试。 |
| `tools/row-startup-test.mjs` | **预设行启动自检**：每一行能否安全 import + apply。 |
| `tools/philosophy-test.mjs` | 摘要增强逻辑的单元测试（含 off 档短路）。 |
| `tools/sync-preset.mjs` | 命令行的修复/检查。 |
| `tools/recover.mjs` | 命令行还原被压缩的原文（不开 DSH 也能用）。 |
| `tools/migrate-session.mjs` | 把会话搬到别的工作区（保住 zstd 帧边界）。 |
| `tools/recover.mjs` | 命令行还原被压缩的原文（不开 DSH 也能用）。 |
| `tools/repair-session-logs.mjs` | 修复被旧版搬迁脚本压坏的会话日志。 |
| `dsh.plugin.json`、`locale/`、`icon.svg` | 插件页的显示信息与图标。 |

## 三个插件的对比

市面上与本插件目的相近的三种做法。数据来自各自公开文档与本仓库实测。

| 维度 | **DSH 内置压缩**（`compaction-basic`） | **billion-context**（BC） | **本插件**（`dsh-compaction-ask`） |
| --- | --- | --- | --- |
| **何时压** | 到 `thresholdRatio`（默认 80%）自动压 | 三层门控：窗口下限 + 增量 + 最小区间 | **你说压才压**（阈值 22–95%，可调） |
| **谁决定** | 代码按阈值 | 模型按任务判断 | **你**（模型只写摘要） |
| **压哪段** | 尾部保留 `retainRatio`（默认 16%），其余全压 | 只压已消费增量，保留近期区约 50K | 可选：随包尾部策略 或 BC 式增量策略（保护区 5 条 + 首尾用户消息） |
| **压缩粒度** | 一段连续区间 → 一条摘要 | 分块，可分层蒸馏 tier-1/2/3 | 一段连续区间 → 一条摘要（**同 DSH，无分层**） |
| **原文可否找回** | 日志里有，但**原设计无工具** | 块级 `decompress`，摘要有磨损 | **完整日志 + `context_recover`，保真度 100%** |
| **摘要质量可调** | 否 | 否（tier 是压缩层级，不是质量档位） | **是：关闭 / 精简 / 平衡 / 严格四档，含压缩后验收** |
| **摘要质量可量化** | 否（只校验「比原文小」） | 靠模型自觉 | **是：锚点覆盖率 / 理由标记 / 结构 / 密度 / 预算** |
| **成本** | 压缩调用一次 | 每次调用多约 2K 哲学（小窗口下是 25% 固定开销） | 默认零额外开销；开质量档位后判据约 1.7–2.3K |
| **实现规模** | 内置，随 DSH 走 | 约 10k 行内核 + 多宿主适配 | 本仓库 `lib/` 约 10 个文件 |
| **适合谁** | 想省事、能接受自动压缩 | 长期跑马拉松会话、愿意换整套工作流 | **想自己掌控时机、又不想丢历史** |

### 一句话各自

- **DSH 内置**：够用、省心，但你不知道它什么时候压、压了什么，压完只能看摘要。
- **billion-context**：压缩质量与长会话能力强得多，代价是接管整条链路（它的 gate 会禁用 `compaction-basic`），且与 DSH 的交互模型不同。
- **本插件**：只做「压缩前先问你」这一件事，但把**决策权、可追溯性、质量档位**都补上了。它不是 BC 的替代品——需要真正的分层折叠与块级可逆仍然要用 BC。

### 三者能不能一起装

**不能同时启用**，但可以同时安装。

| 组合 | 结果 |
| --- | --- |
| BC 装但**不启用** + 本插件 | ✅ 没问题（默认状态） |
| BC **启用** + 本插件 | ❌ 冲突：BC 的 `bili-compaction-gate` 把 `compaction-basic` 整行 `disabled: true`，本插件就没有可询问的引擎 |
| BC 单独 | ✅ 但失去「压前询问」的交互 |

**「启用」的唯一标志是 profile `package.json` 的 `dsh.profile.bundles` 数组**，`dependencies` 里有它不算启用。

### 两个按钮：二选一切换

设置页最下方有「压缩链路归属（二选一）」卡，两个按钮互斥：

| 按钮 | 做什么 | 旁边写明的代价 |
| --- | --- | --- |
| **启用「压缩询问」** | 把 `billion-context` 从 `profile.bundles` 移除 | 恢复「压前询问」，但失去 BC 的分层折叠 |
| **启用 billion-context** | 把 `dsh-compaction-ask` 从 `profile.bundles` 移除 | 交出压缩链路，**失去**压前询问与 `context_recover` 工具 |

**两者都只改 `dsh.profile.bundles`，`dependencies` 一律保留**，所以随时可以切回来，不用重装。

切换是**幂等**的：已经是目标状态时点按钮不会重复改动。切换成功后需要重启 DSH 生效。

### 自动让路（兜底，不依赖按钮）

即使你不点按钮，本插件启动时也会兜底检测：

本插件启动时会检测 `billion-context` 是否被启用。**如果检测到，自动把它从 `dsh.profile.bundles` 移除**（`dependencies` 保留，方便随时切回），并在日志里说明原因。

设置页的「预设快照」卡里有一行 **冲突插件**，实时显示当前状态：

| 显示 | 含义 |
| --- | --- |
| 未发现（已检查 N 个已知包） | 没有冲突 |
| 已自动停用 billion-context | 启动时检测到并已移除 |
| billion-context 已启用（会冲突） | 检测到但还没生效（需要重启） |
| 无法检测（原因） | 读不到 profile 清单 |

**为什么在启动时改，而不是每次读取都改**：`status` 路由是高频读，如果每次都写盘，就变成「打开设置页就改配置」了。所以 `apply` 里改一次，`status` 里只报告。

**失败即放弃**：读不到、写不了、结构不符 —— 一律返回「没处理」，绝不让插件因此起不来。

## 许可

MIT。
