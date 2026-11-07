# Feature Specification: 0.5.4 缺陷批次（模型选择器 / skill 引用 / 更新回显）

**Feature Branch**: `release/0.5.4`

**Created**: 2026-11-07

**Status**: Draft（T001 未取证前不得进入 Phase 2；D5 根因已确证，见「开工前置」）

**Input**: 用户 0.5.4 真机验收后给出的 5 条缺陷清单：

1. 模型选择框，弹出是自动滚动到选中项？考虑性能影响
2. 模型选择框，按供应商分组
3. 引用 skill，会把 skill 内容打印到会话消息中，不行
4. 选模型的弹窗弹出之后，点击弹窗之外的区域，弹窗不关闭
5. 更新 pi 结果回显有乱码

**澄清结论（2026-11-07）**：

| 项 | 用户决定 |
|---|---|
| 文档形态 | 缺陷修复同样走 feature 三段式（与 010-ui-polish 一致），目录命名 `defects` 而非业务名；本 spec 用「现象 → 根因 → 期望行为 → 回归场景」结构，不硬套业务价值叙事 |
| 模型选择器 | **全做，性能收敛**：打开定位 + 分组 + 点外部关闭；定位只在打开时做一次布局计算，保留 200 条渲染上限，**不引入虚拟列表** |
| skill 引用 | 会话里**只显示引用标记**（`/skill:名称` + 用户的问题），skill 全文不进消息气泡 |
| 乱码口径 | 用户判定为**中文编码错乱**（问号 / 方块 / `Ã©` 一类），不是纯 ANSI 进度条残留；清洗控制字符作为附带加固 |
| 补充（08:08） | **乱码只在 Windows 出现**：DOS/控制台命令输出走本地 OEM/ANSI 代码页（西文近似单字节 ASCII，中文 Windows 为 CP936/GBK），而 JVM 自 JDK 18 起默认 UTF-8（JEP 400），两者对不上。**setup 检测 pi 时踩过同一个坑**，历史修复 `b2d32b2` 引入了 `OsProcess.decodeOutput`；本批次是同一根因在 CLI 管理命令读入层的漏网 |

**约束基准**：`specs/README.md` 记载的 Spec Kit 宪法约束（`.specify/memory/constitution.md` 为 machine-local、被 `.gitignore` 忽略，当前工作机不存在，原文读不到）：
第 II 条「无断言覆盖不得标记完成」、第 III 条「不得依赖运行时环境假设」，以及 010 沿用下来的「几何/行为断言不得只断言存在」。
另受 008-i18n 约束：新增可见文案 MUST 同时进 `en.ts` / `zh.ts`。

## 问题陈述

| # | 现象 | 代码定位（已核对） | 根因 / 待证 |
|---|---|---|---|
| D1 | 弹出模型框时看不到当前选中的模型，得自己滚去找；同时担心长列表下自动滚动会卡 | `web/src/components/ModelPicker.tsx:23-29` 打开时 `setHighlight(0)`；`:44-47` 只把 `data-active` 的第 0 项 `scrollIntoView({block:"nearest"})`，且依赖 `[highlight, matches.length, open]` 每次触发 | 打开时高亮被重置为 0，从未按 `model.provider/model.id` 定位；现有 `scrollIntoView` 每次高亮变化都触发，长列表下有布局抖动风险 |
| D2 | 模型是扁平一大串，看不出谁属于哪个供应商 | `ModelPicker.tsx:106-127` 平铺 `matches`，provider 只是每行右侧一个小字；`web/src/store/types.ts:98-104` 的 `ModelInfo.provider` 已有可直接分组的字段 | 渲染层没有分组步骤；`MAX_RENDERED = 200` 截断在扁平列表上做，分组后索引映射需要重算 |
| D3 | 引用 skill 后，SKILL.md 全文被打印进会话消息 | `web/src/components/Composer.tsx:369-372` 只写入 `/skill:name `；`web/src/store/store.ts:1063-1073` 乐观用户项也只含用户原文；`web/src/store/types.ts:8-13` 的 `ContentBlock` 只有 text/thinking/image/toolcall；`MessageList.tsx:13-15` 把 text 块整段交给 `Markdown` | 全文来自 **pi 侧 `/skill:` 命令展开后的真实用户消息**，插件在回放/渲染时原样吐出。pi 用「纯 text 块」还是「带 skill 元数据的独立块」未取证，见 T001 |
| D4 | 模型弹窗打开后点弹窗外，弹窗不关 | `ModelPicker.tsx:14,64,95-96` 的 `open` 只有 chip toggle 与搜索框 Esc 两条关闭路径；**无 document 级 outside-click 监听** | 对比 `web/src/components/OptionsPopover.tsx:64-78` 已有 `rootRef + document mousedown + Escape` 的成熟实现，模型弹窗没有复用 |
| D5 | Manage → Environment 更新 pi 后，结果条里中文变乱码（**Windows 特有**） | `src/main/kotlin/dev/pi/agent/manage/PiManage.kt:373` 把 `(stdout + "\n" + stderr).trim().take(2000)` 原样透传；`web/src/components/ManageView.tsx:58-64,238-244` `OutcomeBanner` 纯文本直出；`PiCliRunner.kt:140-149` 的 `drainThread` 用 `stream.bufferedReader()`（**JVM 默认 charset = UTF-8**）按行解码 | **已确证（用户补充 + 历史提交）**：Windows 上 `cmd /c` shim / 原生工具按本地 OEM/ANSI 代码页输出（zh-CN = CP936/GBK），UTF-8 严格解码失败 → 出现 `????` / `\uFFFD`；反向的「UTF-8 输出被按单字节代码页读」则出现 `Ã©` 型。修法已存在：`OsProcess.kt:33-50` 的 `decodeOutput(bytes)`（严格 UTF-8 → 回退 `native.encoding`），但 **`drainThread` 是唯一没接上它的进程输出读入点**。次要因素：`PI_NO_COLOR=1` 挡不住子进程 ANSI/进度条控制字符；`take(2000)` 可能切断 surrogate pair |

**历史证据（D5 不再是猜测）**：`OsProcess.kt:22-31` 的注释记着同一根因——「`where` / `dir` 按 ANSI/OEM 代码页打印，中文安装路径 `D:\软件\nodejs\pi.cmd` 被 JVM 默认的 UTF-8 解成 `D:\????\nodejs\pi.cmd`，看起来像 pi 没装好」；提交 `b2d32b2` 为此加了 `decodeOutput` 并让 `PiLocator.runCapture`（`pi --version` / `where pi`，setup 检测链路）改走它。**漏网的是 `PiCliRunner.runProcess` → `drainThread`**：`PiEnvironment.kt:391-409` 的 `toolVersion`（`node -v` / `npm -v` / `pi --version`）与 `npmConfiguredRegistry` 也走这条读入层，因此本批次修一处会同时惠及 setup 检测，但必须一并回归（FR-021）。

> D1/D2/D4 是同一组件的三处改动，合并为一个回归主题；D3、D5 各一个。三者无代码依赖，但**实现顺序固定**：模型选择器（纯前端、随时可回滚）→ skill（依赖 T001 契约）→ 输出解码（改的是全局 CLI 读入层，放最后以便一次回归全部 CLI 命令）。

## 开工前置

沿用 009 T001「先真机复核根因再改代码」的做法。**只有 T001 仍是阻塞项**：D5 的根因已由用户补充与 `b2d32b2` 双向确证，T002 降级为验收证据、T003 为规模记录。

- **T001**（阻塞 Phase 2）：抓一次真实 `pi --mode rpc` 会话里引用 `/skill:<name>` 后的消息事件原始报文（`message_end` / `get_messages` / 会话 jsonl 均可），确认展开内容落在哪个字段、是否带 skill 元数据。**未确认前不得写死识别规则**。
- **T002**（非阻塞）：在 **Windows 真机**上抓一次 `pi update --self` 的结果条截图与 stdout 字节，记下当前控制台代码页（`chcp`），确认出现在 `env-update-result` 还是 Packages 结果条；作为 SC-004 的验收证据，不再决定实现方案。
- **T003**（非阻塞）：记录真机 `get_available_models` 的条目数与 provider 数量，作为「不引入虚拟列表」这条决策的实测依据。

## User Scenarios & Testing *(mandatory)*

> 本批次 5 个 User Story 均为**回归场景**：目标是恢复/补齐既有交互的正确行为，故每个 US 写「现象 → 期望」，不写业务价值论证。

### User Story 1 - 弹出即定位当前模型，且不为长列表付性能代价 (Priority: P1)

模型列表很长时，用户打开选择器只想确认「我现在用的是哪个」，不该自己滚；同时这次定位不能让每次打开都卡一帧。

**Independent Test**: 构造 200 条模型、当前模型位于第 180 条，打开 popover → 断言当前项在 `.model-list` 可见区内、`data-active="true"`，并断言打开过程只有一次布局读取（不逐项 `scrollIntoView`）。

**Acceptance Scenarios**:

1. **Given** 当前模型在列表第 180 位，**When** 打开 popover，**Then** 该项完整落在 `.model-list` 可见区内（`optionRect.top ≥ listRect.top` 且 `optionRect.bottom ≤ listRect.bottom`），且键盘高亮落在它上面。
2. **Given** 当前模型已在前几条（本来就可见），**When** 打开 popover，**Then** 不产生任何滚动（打开前后 `scrollTop` 相同），消息列表与工具窗整体也不被滚动。
3. **Given** 200 条模型，**When** 连续用 ↑↓ 导航，**Then** 仅当目标项不可见时才滚动；定位与导航共用同一个「已可见则跳过」判断，不发生布局抖动。
4. **Given** 200 条模型，**When** 打开 popover，**Then** 分组/过滤/索引计算走 memo，定位在单次 `requestAnimationFrame` 内完成，不在 `render` 阶段逐个测量所有节点。
5. **Given** 无当前模型、或当前模型不在 `models` 里（自定义 / 加载失败），**When** 打开 popover，**Then** 不滚动、不报错、高亮回落到第 0 项。

### User Story 2 - 按供应商分组 (Priority: P1)

用户想按 provider 找模型，而不是在一长串 id 里扫。

**Independent Test**: 用 3 个 provider、共 12 条模型的 fixture 打开 popover → 断言组标题数量/顺序/计数，以及分组后键盘 ↑↓ 与 Enter 选中的仍是正确模型。

**Acceptance Scenarios**:

1. **Given** models 含 3 个 provider，**Then** 渲染 3 个组标题，每个标题带 provider 名与组内条目数。
2. **Given** 当前模型属于 provider B，**Then** B 组排在最前（其余组保持 pi 返回顺序，不做字母重排）。
3. **Given** 过滤词只命中 2 个组里的模型，**Then** 只显示这 2 个组，计数按过滤后结果计算；无命中时仍显示既有的 `model-empty`。
4. **Given** 分组渲染后，**When** ↑↓ 跨组边界，**Then** 高亮连续、`Enter` 选中的模型与视觉高亮一致（`data-testid="model-chip"` 文案随之更新）。
5. **Given** 总条目 > 200，**Then** 仍按总条目数截断并显示「还有 N 条，请细化过滤」，组内不各自截断。
6. **Given** provider 字符串为空或缺失，**Then** 归入单一兜底组，不产生空白标题或崩溃。

### User Story 3 - 点弹窗外关闭 (Priority: P1)

打开模型弹窗后点消息列表、输入框或别的工具条，弹窗应该消失；点弹窗内部（搜索框、滚动条、选项）不能误关。

**Independent Test**: 打开 popover 后分别点击「消息列表」「输入框」「弹窗内搜索框」「chip 本身」，断言前两者关闭、后两者不误关/不二次开合。

**Acceptance Scenarios**:

1. **Given** popover 打开，**When** `mousedown` 落在 `.model-picker` 之外，**Then** `model-popover` 隐藏，且底层不触发任何模型切换。
2. **Given** popover 打开，**When** 点击内部搜索框 / 滚动条 / 选项区域，**Then** 保持打开；点选项走既有 `pick()` 并关闭。
3. **Given** popover 打开，**When** 点击 chip 本身，**Then** 是「关闭」一次（toggle 生效），**不会**因 outside-click 先关、onClick 又开而出现「点了没反应」。
4. **Given** popover 打开，**When** 按 Esc，**Then** 保持既有行为：关闭，且输入框里已输入的文字不丢。
5. **Given** 确认框（007）或 Options 弹层（008）打开，**When** 模型弹窗同时开着并点其外部，**Then** 只关模型弹窗，不吞掉其它弹层的点击、不触发它们的取消/确认。
6. **Given** popover 关闭，**Then** document 级监听被移除（不残留全局 `mousedown`）。

### User Story 4 - 引用 skill 只显示引用标记 (Priority: P1)

用户引用 skill 只想让 pi 用上这份说明，不想让 SKILL.md 全文铺满会话，也不想复制/引用时把全文带出去。

**Independent Test**: 在 mock 里推送一条「pi 展开后的 skill 用户消息」，断言消息气泡只出现 `/skill:<name>` 与用户附加问题，DOM 里不含 SKILL.md 特征串；再点 Copy / Quote，断言得到的仍是引用标记而非全文。

**Acceptance Scenarios**:

1. **Given** pi 回放的用户消息含 SKILL.md 全文 + 用户问题，**Then** 消息气泡只显示 `/skill:<name>` 标记与用户附加的问题，全文不出现在 DOM。
2. **Given** 同一条消息，**When** 点 Copy / Quote / 编辑重发 / 重新生成，**Then** 拿到的是引用标记文本（`/skill:<name> 问题`），不是展开全文；Fork 后的会话同样不回显全文。
3. **Given** 切到历史会话回放，**Then** 折叠规则与实时消息一致（不出现「重开会话又冒出全文」）。
4. **Given** 未引用 skill 的普通用户消息，**Then** 渲染、复制、引用的文本逐字不变（零回归）。
5. **Given** 用户自己手打了一段长得像 SKILL.md 的文本（没有 `/skill:` 引用），**Then** 不被误折叠，全文照常显示。
6. **Given** 中英文界面切换，**Then** 引用标记与（若有的）提示文案都走字典，不出现键名。

### User Story 5 - 更新 pi 结果不再乱码 (Priority: P1)

Manage → Environment 更新 pi、Packages 更新扩展包后，结果条里的中文/emoji 应原样可读，且不夹带终端控制字符。

**Independent Test**: 用一段固定字节（UTF-8 中文 + emoji + ANSI 进度条 + 超长文本）驱动 CLI 读入层与输出拼装，断言结果条文本精确等于期望字符串，不出现 `?`、`\uFFFD`、`Ã`、`\u001B[`。

**Acceptance Scenarios**:

1. **Given** 子进程输出 UTF-8 编码的「已更新到 1.5.0 ✅」，**Then** 结果条逐字显示该文本，无替换符、无问号、无 `Ã©` 型双编码。
2. **Given** 输出含 ANSI CSI / `\r` 进度条 / 退格，**Then** 结果条只保留可读文本，控制序列被剥离；正常文本里的 `[`、中文、换行不受影响。
3. **Given** 输出超过 2000 字且第 2000 个字符恰好是 emoji 的一半，**Then** 截断不产生半个字符（无孤立 surrogate），并在截断处给出可见省略标记。
4. **Given** 更新失败（exitCode ≠ 0），**Then** stdout/stderr 都仍可诊断，退出码与 `ok=false` 不因清洗而丢失。
5. **Given** 纯 ASCII 输出，**Then** 与改动前逐字节一致（`PiCliRunnerTest` / `PiManageUpdateTest` 既有断言不破）。
6. **Given** 其它 `manage.*` CLI 命令（mcp / packages / auth / settings）仍走同一个 `drainThread`，**Then** 它们的输出与解析结果不回归。
7. **Given** Windows（zh-CN、控制台 CP936/GBK）上 `cmd /c` shim 输出本地代码页字节的中文，**Then** 结果条按 `native.encoding` 正确还原中文，不出现 `????` / `\uFFFD`；**同一路径**下 pi / node 自己的 UTF-8 中文输出仍逐字正确（两个方向都成立，不做单边修复）。

### Edge Cases

- 模型列表：`models=[]`、`models.length=1`、`provider` 大小写不一致（`OpenAI` vs `openai` 视为两个组还是归一，见开放问题 3）、同名 id 不同 provider、过滤词含空格（既有 AND 语义不得破坏）。
- 定位：popover 在窄工具窗（360px）下高度受限、分组标题占高、模型列表异步晚到（`sources.models` 从 loading 变 ready）、打开瞬间切换会话导致 `model` 变化。
- skill：一条消息里引用多个 skill；skill 名含连字符/冒号；用户问题为空；pi 展开文本没有可识别边界（此时 MUST 走 T001 定下的兜底，不得用长度阈值猜）。
- 乱码：输出里合法含 `\u001B`（极少见，按 CSI 语法剥离而非见字符就删）、CRLF、NUL 字节、超长单行无换行符、`stdout` 与 `stderr` 交错；Windows 中文安装路径（`D:\软件\...`）、`chcp` 切换后代码页变化、控制台 OEM 代码页与 ANSI 代码页不一致（CP437/850 vs CP936）。

## Requirements *(mandatory)*

### Functional Requirements

**US1 定位与性能**

- **FR-001**: 打开 popover 时 MUST 按 `model.provider + model.id` 找到当前项，令其完整可见，并把键盘高亮设为该项。
- **FR-002**: 定位 MUST 只在「打开」时执行一次；已可见时 MUST NOT 触发滚动。MUST NOT 用 `scrollIntoView` 滚动整个工具窗/消息列表，只允许调整 `.model-list` 自己的 `scrollTop`。
- **FR-003**: 键盘导航保留滚动能力，但 MUST 先判断目标项是否可见；`scrollIntoView` 不得无条件在每次 `highlight` 变化时调用。分组/过滤/索引计算 MUST memo 化，打开路径的布局读取 ≤ 1 次。
- **FR-004**: 保留 `MAX_RENDERED = 200` 上限；本批次 MUST NOT 引入虚拟列表/窗口化，也不得为定位额外渲染全量模型。
- **FR-005**: 当前模型缺失或不在列表中时 MUST 安全回落（不滚动、不报错、高亮为 0）。

**US2 分组**

- **FR-006**: 列表 MUST 按 `ModelInfo.provider` 分组，渲染组标题（provider 名 + 该组条目数）。
- **FR-007**: 当前模型所属组 MUST 置顶；其余组与组内条目保持 pi 返回顺序；provider 为空/缺失 MUST 归入单一兜底组。
- **FR-008**: 过滤后 MUST 只保留有命中的组，计数按过滤结果；跨组 ↑↓ / Enter / 鼠标 hover 的索引映射 MUST 与视觉顺序一致；`MAX_RENDERED` 按总条目数截断并显示剩余数。

**US3 外部关闭**

- **FR-009**: popover 打开时 MUST 注册 document 级 `mousedown`（或等价捕获），落在 `.model-picker` 之外即关闭；关闭时 MUST 移除监听。
- **FR-010**: 根节点 ref MUST 包住 chip 与 popover，使点击 chip 不触发「先关后开」的二次 toggle；Esc 关闭行为与 007/008 的弹层语义保持一致。
- **FR-011**: 与 `ConfirmDialog`、`OptionsPopover`、slash/file 补全菜单共存时 MUST 互不干扰（不吞事件、不误触发确认或取消）。

**US4 skill 引用**

- **FR-012**: skill 全文 MUST NOT 出现在用户消息气泡（实时与回放）；只呈现 `/skill:<name>` 标记 + 用户附加问题。
- **FR-013**: 折叠规则 MUST 建立在 T001 取证的真实 pi 契约上；MUST NOT 以「文本长度阈值」或「猜 frontmatter」作为唯一识别手段。
- **FR-014**: 数据层保留原文（不破坏会话回放一致性），渲染、Copy、Quote、编辑重发、重新生成 MUST 统一走同一个 `displayText()` 之类的入口取折叠后的文本。
- **FR-015**: 未引用 skill 的消息 MUST 逐字不变；用户手写但长得像 skill 内容的文本 MUST NOT 被误折叠。
- **FR-016**: 新增可见文案 MUST 进 `en.ts` / `zh.ts`（008 约束）。

**US5 输出解码与清洗**

- **FR-017**: `PiCliRunner` 读取子进程 stdout/stderr MUST 按字节解码并复用 `OsProcess.decodeOutput`：字节流是合法 UTF-8（pi / node / JCEF 侧）时按 UTF-8，否则（Windows `cmd /c` 与原生工具的 OEM/ANSI 代码页，zh-CN 为 CP936/GBK）回退 `native.encoding`。MUST NOT 依赖 `bufferedReader()` 的 JVM 默认 charset（JDK 18+ 恒为 UTF-8），MUST NOT 用替换符吞掉无法解码的字节。两个方向（UTF-8 输出 / 本地代码页输出）MUST 同时成立。
- **FR-018**: 结果条文本 MUST 剥离 ANSI CSI、`\r` 进度条与退格残留，同时不得剥离正常文本里的 `[`、中文、换行。
- **FR-019**: 输出截断 MUST 按 UTF-16 code point 安全进行，不得切断 surrogate pair；截断处 MUST 有可见标记。
- **FR-020**: 清洗 MUST NOT 丢失 stdout/stderr、`exitCode`、`ok`、版本号等诊断信息。
- **FR-021**: `envUpdate` 与 `packageUpdate` 两条链路 MUST 共用同一套解码与清洗实现；其它 CLI 命令的输出 MUST 零回归；`PiEnvironment` 的 `toolVersion` / `npmConfiguredRegistry`（同样走 `PiCliRunner.runProcess`）MUST 一并受益，Windows 中文安装路径下 setup 检测（Node / npm / pi 版本）不得回归。

**通用**

- **FR-022**: 所有几何/行为断言 MUST 量化（可见区矩形、scrollTop、DOM 文本精确值），不得只断言元素存在。
- **FR-023**: 既有 `typecheck` / `vitest` / `playwright` / `gradlew test` 全量 MUST 保持绿；被基线变化影响的断言必须在提交信息里注明「基线变化，非回归」。

### Key Entities

- **ModelGroup**：`{ provider, items: ModelInfo[], isCurrentGroup }`，由纯函数从 `models` + `currentModel` + 过滤词生成；组顺序 = 当前组优先 + pi 原序。
- **平铺索引**：把分组结果映射回一维 `optionIndex`，供 `highlight` / `pick()` / `MAX_RENDERED` 复用，避免分组后键盘导航错位。
- **skill 显示文本**：`displayText(raw, originalPrompt?)`，数据层原文与 UI 层展示文本的唯一转换点。
- **CLI 输出管道**：`readBytes → OsProcess.decodeOutput → sanitizeCliOutput → safeTruncate → JsonObject.output`，单一实现，所有 `manage.*` 更新类命令复用。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 200 条模型 / 当前项在第 180 位时，打开后当前项完整可见且高亮命中；打开路径布局读取 ≤ 1 次，已可见场景 `scrollTop` 变化为 0。
- **SC-002**: 3-provider fixture 下组标题数 = 3、当前组置顶、过滤/截断/跨组键盘导航全绿；外部点击矩阵（4 类点击目标 + Esc + 监听移除）全绿。
- **SC-003**: skill 展开消息在 DOM 中不可见（e2e 断言页面文本不含 SKILL.md 特征串），Copy / Quote 得到的文本等于引用标记；普通消息文本逐字一致。
- **SC-004**: 固定字节样例（UTF-8 中文 + emoji + ANSI + 超长 + **Windows CP936/GBK 中文安装路径**）经结果条渲染后精确匹配期望字符串，无 `\uFFFD` / `????` / `Ã©`；纯 ASCII 输出与改动前逐字节一致；既有 Kotlin CLI 测试全绿，Windows 真机截图为验收证据。
- **SC-005**: 全量测试绿，数字回填执行记录：基线为 0.5.3 的 `vitest 165` / `playwright 176` / `gradlew test ✅` / `typecheck 0 错误`。
- **SC-006**: `MANUAL_TEST.md` 新增 0.5.4 缺陷回归段（模型选择器、skill 引用、更新回显），每条可在真机目视执行。

## Non-goals

- **虚拟列表 / 窗口化渲染**：用户明确要求「考虑性能影响」但选择收敛方案，本版保留 200 条上限，不引新依赖、不改渲染架构。
- **分组折叠、拖拽排序、收藏/最近使用**：只做静态分组标题与当前组置顶。
- **改变 pi 的 skill 展开行为**：pi 仍照常把 skill 内容送进模型上下文，插件只改「呈现」。
- **搜索索引与 HTML 导出里的 skill 折叠**：006 的会话内/全会话搜索与 `SessionHtmlExporter` 保持原文，理由是归档/检索时命中 skill 内容对用户有用；若后续要求「任何地方都不出现全文」，另立规格统一改造。
- **非 update 类命令输出的编码治理**：`drainThread` 是全局读入层，改动天然覆盖所有 CLI 命令，但本版不对各命令的输出格式做额外加工（只加回归断言）。
- **主题、字号、气泡密度等样式重构**：只加分组标题所需样式。

## 开放问题（写进 spec 以便执行时逐条关闭）

| # | 待确认 | 谁提供 | 影响 |
|---|---|---|---|
| Q1 ✅ **已关闭**（2026-11-07） | D5 乱码的环境与方向 | 用户补充 + `b2d32b2` 代码证据 | **Windows 特有**：DOS/OEM 本地代码页输出 vs JVM 默认 UTF-8；setup 检测 pi 时同一根因已由 `OsProcess.decodeOutput` 修过。实现方案定为「按字节读 + 严格 UTF-8 → 回退 `native.encoding`」，不再需要靠样例猜；T002 只补一张 Windows 结果条截图作验收证据，不阻塞开工 |
| Q2 ✅ **已关闭**（2026-11-07 真机取证，T001） | 分支 **b**：单个 `type:"text"` block 内 `<skill name="…" location="…">…</skill>\n\n` + 用户原话；原始 `/skill:` 命令不落盘，回放形态一致；pi 自带官方逆解析正则（插件照抄）。证据与实现见 plan.md D4 | 决定 FR-013 的识别规则：定界解析，不新增 ContentBlock 变体 |
| Q3 ✅ **已关闭**（2026-11-07 真机取证，T003） | 359 模型 / 2 provider（openrouter 355 + 自定义 xiami 4），provider 全小写无混用 | 「不引虚拟列表」成立；FR-007 无需归一，按精确 provider 字符串分组（测试覆盖大小写混用的确定性） |
| Q4 ✅ **已关闭**（按默认实现） | 未加工具窗外焦点监听（JCEF 内收不到窗外点击，改造成本高收益低） | 写进 Non-goals：popover 在 IDE 焦点离开工具窗时保持原状，回到窗口后点外部可关 |
