# Implementation Plan: 0.5.4 缺陷批次

**Feature**: `specs/011-0.5.4-defects/spec.md`

**Branch**: `release/0.5.4`（直接在版本分支上做，与 0.5.2/0.5.3 一致）

**Status**: Ready to implement（**仅 T001 阻塞 Phase 2**；D5 根因已由用户补充与 `b2d32b2` 确证，Phase 3 可直接开工）

## 摘要

3 个回归主题、5 条缺陷，改动集中在三处：

1. **前端 `ModelPicker`**：把扁平列表换成「分组 + 平铺索引」的渲染模型；打开时按当前模型做一次定位；补 document 级 outside-click。性能靠 memo 与「已可见则不滚动」收敛，不引虚拟列表。
2. **前端 skill 呈现**：新增唯一的 `displayText()` 转换点，渲染与消息操作统一取折叠后的文本；数据层保留 pi 原文。识别规则由 T001 抓包结果决定，**先取证再写实现**。
3. **Kotlin CLI 读入层**：`drainThread` 从「JVM 默认 UTF-8 按行解码」改成「按字节读 + `OsProcess.decodeOutput` 自适应解码（UTF-8 → 回退本地代码页）」，再经统一的清洗/安全截断拼成 `JsonObject.output`。这是 **Windows 特有问题**（DOS/OEM 代码页输出 vs UTF-8）在 CLI 管理命令上的漏网，与 `b2d32b2` 修过的 setup 检测是同一根因；改动放最后以便一次回归全部命令与 setup 链路。

## 技术上下文

- 前端：React 18 + TS + Vite；样式单文件 `web/src/styles.css`（约 3.5k 行，历史上有新旧两套定义并存，改前确认命中哪一处；模型弹窗样式在 `:1052-1125`）。
- i18n：`web/src/i18n/locales/{en,zh}.ts` 双字典；`useT()` 取词；008 的 `i18n.spec.ts` 会卡「键名漏进界面」。新增文案必须双语同时加。
- 桥接/mock：`web/src/bridge/mock.ts` 驱动全部 e2e；新增 fixture 必须落在 mock 里，禁止 e2e 依赖真实 pi。
- 测试：`vitest`（纯函数）、`playwright`（`web/e2e/*.spec.ts`，mock bridge）、JUnit（`src/test/kotlin/...`）、真机 JCEF（`scripts/e2e-ide.ps1` / `.sh` + `MANUAL_TEST.md`）。
- 既有模型选择器断言：`web/e2e/chat.spec.ts:81-111`（打开/过滤/选中/✓ 标记）、`layout.spec.ts:64-95`（chip 文案与 title）。分组会改变 DOM 结构，这两处需复跑，必要时按「基线变化，非回归」修正。
- 既有 outside-click 参考实现：`web/src/components/OptionsPopover.tsx:62-78`（`rootRef` + document `mousedown` + Escape，仅 open 时挂载）。
- 既有解码工具与历史证据：`OsProcess.kt:22-50` 的 `nativeCharset` / `decodeOutput(bytes)`（严格 UTF-8，失败回退 `native.encoding`）由提交 `b2d32b2` 引入，修的是「中文安装路径下 `where pi` 输出按本地代码页解码」——即用户说的「检测 pi 时也有类似乱码」。`PiLocator.runCapture:277-290` 已改用它；`PiCliRunner.drainThread` 是唯一漏网的进程输出读入点。`PiEnvironment.kt:391-409` 的 `toolVersion` / `npmConfiguredRegistry` 也走 `PiCliRunner.runProcess`，因此同批受益、同批回归。
- 现有测试基线（0.5.3 执行报告）：`typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅`。
- **T003 取证结论（2026-11-07，pi 1.4.0 真机 + RPC）**：`get_available_models` 返回 **359 条模型 / 2 个 provider**（openrouter 355 + 用户自定义 xiami 4），provider 名全小写、无大小写混用；单条字段含 `provider/id/name`（人读名 "Vendor: Model"）与 `contextWindow` 等，无 `displayName`。条数是采样值不是契约值（`pi update` 刷新目录），UI 不硬编码。分组按精确 provider 字符串（小写一致，无需归一）；「不引虚拟列表、保留 200 条上限」维持。

## 现状与目标

| 主题 | 现状 | 目标 |
|---|---|---|
| 打开定位 | `ModelPicker.tsx:23-29` 打开即 `setHighlight(0)`；`:44-47` 依赖 `[highlight, matches.length, open]` 无条件 `scrollIntoView` | 打开时按 `provider/id` 定位并同步高亮；已可见不滚动；导航才滚动；打开路径布局读 ≤ 1 次 |
| 分组 | `:106-127` 平铺 `matches.slice(0, 200)`，provider 仅为行内小字；`model-option-provider` 样式 | 组标题（provider + 计数）+ 当前组置顶；平铺索引供键盘/截断复用；过滤只留命中组 |
| 外部关闭 | `open` 仅 chip toggle 与搜索框 Esc | 复用 OptionsPopover 模式，rootRef 包住 chip + popover；关闭时移除监听 |
| skill 呈现 | `ContentBlock` 只有 4 类，text 块整段进 `Markdown`；Copy/Quote 直接取块文本 | `displayText()` 单点转换；渲染 + 消息操作同源；数据层原文不动 |
| CLI 输出 | `PiCliRunner.drainThread` 用 `bufferedReader()`（**JVM 默认 UTF-8**）→ `appendLine`；Windows 上 `cmd /c` / 原生工具按 CP936/GBK 输出，中文变 `????`/`\uFFFD`；`PiManage.envUpdate:373` / `cliToElement:517` 各自 `trim().take(2000)` 原样透传；`OutcomeBanner` 纯文本直出 | 字节 → `decodeOutput` → `sanitizeCliOutput` → `safeTruncate` 一条管道；两条更新链路共用；UTF-8 与本地代码页两个方向都正确；全 CLI 命令 + setup 检测回归 |

## 开工前置（仅 T001 阻塞）

| Task | 取证内容 | 未拿到时的处理 |
|---|---|---|
| T001（**阻塞**） | 真实 `pi --mode rpc` 里 `/skill:<name>` 展开后的消息事件原始报文（会话 jsonl 亦可） | **停下报告**，不写 FR-013 的实现；spec Q2 保持开放 |
| T002（非阻塞） | Windows 真机上 `pi update --self` 的结果条截图 + stdout 字节 + `chcp` 当前代码页 | **根因已确证**（用户补充 + `b2d32b2`），直接按 FR-017/018 实现；截图只作 SC-004 验收证据 |
| T003（非阻塞） | 真实模型条目数、provider 数、大小写是否混用 | 按「不引虚拟列表」实现，但把数量写回本文件，作为后续版本决策依据 |

## 设计决策

### D1. 分组：纯函数 + 平铺索引，不改 store

新增 `web/src/lib/modelGroups.ts`：

```ts
interface ModelGroup { provider: string; items: ModelInfo[]; current: boolean }
function buildModelGroups(models: ModelInfo[], current: ModelInfo | undefined, keywords: string[]): ModelGroup[]
function flattenGroups(groups: ModelGroup[], cap: number): { options: ModelInfo[]; hidden: number }
```

- 组顺序：**当前模型所属组第一**，其余按 `models` 中首次出现顺序（不打乱 pi 的排序，也不用字母序，避免与 pi 后续变更耦合）。
- 组内顺序 = pi 返回顺序；provider 为空/缺失归入 `t("model.group.other")`。
- 过滤沿用既有「空格分词 AND 匹配 `provider + id + name`」语义，过滤后重建组，组计数按结果算。
- `MAX_RENDERED` 继续按**总条目数**截断（`flattenGroups` 统一处理），不按组各自截断，避免出现「某组凭空少了模型」。
- 键盘 `highlight` / `pick()` 继续用一维索引，取自 `options`；组标题不占索引。这样既有 `chat.spec.ts` 的 `model-option` 计数语义不变（只是 DOM 里多了标题节点）。
- 纯函数进 `vitest`：空列表、单组、当前组置顶、跨组过滤、空 provider、>200 截断、大小写混用（是否归一由 spec Q3 决定，未定前按「原字符串严格分组」）。

### D2. 定位与性能：只调 `.model-list.scrollTop`，不碰 `scrollIntoView` 的祖先滚动

- 打开时（popover 挂载后的单次 `requestAnimationFrame` 或 `useLayoutEffect`）在 `listRef` 内查 `[data-model-key="<provider>/<id>"]`：
  1. 读一次 `option.offsetTop / offsetHeight` 与 `list.scrollTop / clientHeight`；
  2. 已完整可见 → 什么都不做；
  3. 不可见 → 直接赋 `list.scrollTop = ...`（居中偏上），**不用 `scrollIntoView`**，因为它会连带滚动消息列表乃至 JCEF 工具窗。
- `highlight` 的滚动 effect 改为「仅目标项不可见时」才滚，且去掉对 `matches.length` 的无谓触发；打开路径与导航路径共用 `ensureVisible(list, el)` helper。
- `buildModelGroups` / `flattenGroups` 用 `useMemo`（依赖 `models`、`keywords`、`model`），200 条下只算一次；打开时不遍历测量全部节点。
- 当前模型缺失 / 不在列表 → `highlight = 0`，不滚动（FR-005）。
- 性能判据写进 e2e：通过 `data-layout-reads` 之类的计数器或「已可见时 `scrollTop` 不变」的几何断言量化；不引入 `performance.now()` 这类易 flaky 的时间阈值。

### D3. outside-click：照抄 OptionsPopover，但 ref 必须包住 chip

```ts
useEffect(() => {
  if (!open) return;
  const close = (e: MouseEvent) => {
    if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener("mousedown", close);
  return () => document.removeEventListener("mousedown", close);
}, [open]);
```

- `rootRef` 挂在 `.model-picker`（**包含触发 chip**），否则点 chip 会「mousedown 先关 → onClick 再 toggle 开」，表现为点了没反应（FR-010）。这是本批最容易踩的坑。
- Esc 仍由搜索框 `onKeyDown` 处理；不额外挂 document keydown，避免与 007 确认框的 capture-phase Escape 抢事件。
- 只在 `open` 时挂载、关闭即移除（FR-009）；与 ConfirmDialog / OptionsPopover / slash 菜单共存时靠「不改事件、不 stopPropagation」做到互不干扰。
- **JCEF 边界**：点击工具窗外的 IDE 区域，document 收不到 `mousedown`，故默认**不**处理失焦关闭（spec Q4；若用户要求，再加 `focusout` + IDE 焦点桥接，另立 task）。

### D4. skill 折叠：数据层不丢，UI 层单点转换

- 新增 `web/src/lib/skillDisplay.ts`：`displayText(raw: string, originalPrompt?: string): string` + `isSkillExpanded(...)`，返回结果同时给渲染、Copy、Quote、编辑重发、重新生成使用。
- **识别规则由 T001 取证后落定**，三条分支按报文形态选一：
  - a) RPC 事件带 skill 元数据/独立块 → 在 `ContentBlock` 增加 `kind: "skillref"`（带 `name` / `rawText`），reducer 归一化；
  - **b) ✅ T001 已选定（2026-11-07 真机取证，分支 b）**：纯 text 块内 pi 展开文本有稳定边界——展开格式为单个 `type:"text"` block：
    ```
    <skill name="forensics-demo" location="/abs/path/SKILL.md">
    References are relative to <skill 所在目录>.

    <SKILL.md 正文，frontmatter 已剥、已 trim>
    </skill>

    <用户原话>
    ```
    即 `<skill name="…" location="…">\n…\n</skill>\n\n` + 用户原话；原始 `/skill:` 命令**不落盘**（jsonl 直接是展开后文本，回放形态一致）。pi 源码自带官方逆解析 `parseSkillBlock` 正则（`/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/` → `{name, location, content, userMessage}`），插件照抄该正则做识别与折叠，不自造边界。多次 `/skill:` 引用是多条独立 user 消息，各折叠各的。skill 找不到时 pi 原文透传（无边界）→ 自然不折叠。
  - c) 纯 text 块且无边界 → 用发送前记录的**原始 prompt**（`/skill:name 问题`）与回放消息做映射，UI 用原文本覆盖展示。（T001 证实不需要：边界稳定存在。）
- 共同约束：只有「本次会话确实发送过 `/skill:` 引用」的消息才可折叠；用户手写相似文本不折叠（FR-015）。
- 数据层保留 pi 原文，理由：会话回放、006 搜索、`SessionHtmlExporter` 归档仍要能工作；只改呈现层，回滚半径最小。
- 消息操作改动点：`MessageList.tsx`（渲染）、`MessageActions.tsx` 的 Copy/Quote/编辑/重生成路径（`store.ts` 里对应的回填也走 `displayText`）。
- 新增引用标记相关文案（若有）进 `en.ts` / `zh.ts`；`/skill:name` 本身是数据，不翻译。

### D5. CLI 输出：一条管道，复用已有解码工具

```
InputStream.readBytes()
  → OsProcess.decodeOutput(bytes)          // 严格 UTF-8，失败回退 native.encoding
  → normalizeNewlines + sanitizeCliOutput  // 去 ANSI CSI、\r 进度条、\b；不动普通文本
  → safeTruncate(text, 2000)               // 按 code point，不切 surrogate pair；加 "…"
  → JsonObject.output                      // envUpdate / cliToElement 共用
```

- **方向要同时成立**：pi / node / JCEF 侧输出合法 UTF-8 → 严格解码成功；Windows `cmd /c` shim、`where` / npm 提示等原生输出为 OEM/ANSI 代码页字节 → UTF-8 严格解码报 `CharacterCodingException` → 回退 `native.encoding`（JEP 400，中文 Windows 为 CP936/GBK）正确还原。`decodeOutput` 已实现这个判定，直接复用，不重写一套启发式。
- `PiCliRunner.drainThread` 改为按字节读（`InputStream.readBytes()` / `BufferedInputStream` 循环），一次性 `decodeOutput`，再按 `appendLine` 的原语义规范化换行（CRLF → LF、保留末尾换行），保证 `PiCliRunnerTest` 既有的按行断言不破。
- **不采用** `chcp 65001` / 给子进程塞 `-Dfile.encoding`：改控制台代码页会连带改变 pi / npm 自身输出与第三方工具行为，且对已经启动的进程无效；在「读入侧自适应解码」才是最小、双向、无副作用的修法（`b2d32b2` 已验证过）。
- **同批受益面**：`PiEnvironment.toolVersion` / `npmConfiguredRegistry` 走同一个 `runProcess`，改完自动获得正确解码；但它们的输出是版本号 / registry URL（纯 ASCII），所以必须补「Windows 中文安装路径 + 中文 npm 警告」的回归用例，防止「修了中文、弄坏版本解析」。
- `sanitizeCliOutput` 与 `safeTruncate` 放 `PiCliRunner`（或 `PiManage` 同层 util），**不要**在前端 CSS/React 里做字符清洗：Kotlin 侧清洗才能同时覆盖所有调用方与失败诊断。
- ANSI 只按 CSI 语法剥离（`\u001B\[[0-9;?]*[ -/]*[@-~]`），不做「见到 ESC 就删」；`\r` 进度条保留最后一段，`\b` 只影响紧邻字符。
- `PiManage.envUpdate:373` 与 `cliToElement:517` 改为调用同一个 `cliOutput(result)` helper，顺带消除两处重复的 `take(2000)`；`ok` / `exitCode` / `version` 字段原样保留（FR-020）。
- JUnit 用**构造的字节数组**驱动（UTF-8 中文、CP936/GBK 字节如 `D:\软件\...`、ANSI、`\r`、emoji 截断边界、纯 ASCII、CRLF、NUL），不依赖运行机器的 locale（宪法 III）——**macOS 开发机也必须能验证 Windows 场景**。`OsProcessTest` 已有同类用例可作样板。

### D6. 断言策略与 i18n

| 主题 | 新增测试 | 断言要点 |
|---|---|---|
| 分组/定位 | `web/src/lib/modelGroups.test.ts`（vitest）、`web/e2e/model-picker.spec.ts` | 组数/顺序/计数、当前组置顶、跨组 ↑↓ 与 Enter、200 条截断、当前项可见矩形、已可见时 scrollTop 不变、外部点击矩阵、Esc、监听移除 |
| skill | `web/src/lib/skillDisplay.test.ts`、`web/e2e/skill-reference.spec.ts` | 全文不进 DOM、Copy/Quote/编辑/重生成取折叠文本、回放一致、普通消息逐字不变、相似文本不误折叠 |
| 输出 | `PiCliRunnerTest` / `PiManageUpdateTest` 扩展、`web/e2e/update-output.spec.ts` | 固定字节 → 精确文本、无替换符/ANSI、surrogate 安全截断、纯 ASCII 等价、失败诊断不丢、其它 CLI 命令零回归 |
| 全局 | 既有全量 + `i18n.spec.ts` | 双语键齐全、既有 165/176 基线不破；基线变化的断言在提交信息注明 |

- mock 侧新增 fixture：多 provider + 200 条模型、当前模型排在末段、pi 展开后的 skill 用户消息、含中文/ANSI 的更新输出。e2e 不得依赖真实 pi。
- `MANUAL_TEST.md` 新增「0.5.4 缺陷回归」段（真机目视：模型弹窗定位/分组/点外关闭、`/skill:` 引用、中文更新结果条），截图写进执行记录。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/components/ModelPicker.tsx` | 分组渲染、平铺索引、rootRef/outside-click、打开定位与 ensureVisible、memo |
| `web/src/lib/modelGroups.ts` / `.test.ts` | 新增纯函数与单测 |
| `web/src/lib/skillDisplay.ts` / `.test.ts` | 新增 displayText 与单测（规则依赖 T001） |
| `web/src/components/MessageList.tsx`、`MessageActions.tsx`、`web/src/store/store.ts` | 渲染与消息操作统一走 displayText；数据层原文不动 |
| `web/src/styles.css` | `.model-group-title`、组间距；不改既有 `.model-option*` 语义 |
| `web/src/i18n/locales/{en,zh}.ts` | `model.group.*` 等新增文案 |
| `web/src/bridge/mock.ts` | 多 provider/200 条模型、skill 展开消息、中文+ANSI 更新输出 fixture |
| `web/e2e/{model-picker,skill-reference,update-output}.spec.ts` | 新增三组 e2e；复跑 `chat.spec.ts` / `layout.spec.ts` 既有断言 |
| `src/main/kotlin/dev/pi/agent/manage/PiCliRunner.kt` | drainThread 按字节解码；新增 sanitizeCliOutput / safeTruncate / cliOutput helper |
| `src/main/kotlin/dev/pi/agent/manage/PiManage.kt` | `envUpdate` / `cliToElement` 复用同一输出管道 |
| `src/main/kotlin/dev/pi/agent/process/OsProcess.kt` | 复用 `decodeOutput`，必要时补 code-point 安全截断工具（不改原有语义） |
| `src/main/kotlin/dev/pi/agent/manage/PiEnvironment.kt` | **不改代码**，仅纳入回归（`toolVersion` / `npmConfiguredRegistry` 共用 `runProcess`） |
| `src/test/kotlin/dev/pi/agent/manage/{PiCliRunnerTest,PiManageUpdateTest,PiEnvironmentTest}.kt` | 固定字节用例与回归（含 Windows 代码页与中文安装路径） |
| `MANUAL_TEST.md` / `CHANGELOG.md` / `specs/README.md` | 真机判据、变更记录、批次总览 |

## 顺序与依赖

```
Phase 0 取证：T001 ──阻塞──► Phase 2 skill
             T002/T003（Windows 验收证据、规模记录）── 不阻塞实现
Phase 1 模型选择器（独立、纯前端、可随时回滚）── 可先行
Phase 3 输出解码（根因已确证）── 可先行，但仍建议放最后做全局回归
Phase 2 skill（依赖 T001 契约）
Phase 3 CLI 输出解码（全局读入层，最后做，一次回归全部 manage.* 命令）
Phase 4 收尾（全量测试 / MANUAL_TEST / CHANGELOG / 真机目视）
```

- Phase 1 与 Phase 0 无依赖，可并行；Phase 2/3 各自独立，互不共享文件。
- 分组会改变 DOM 结构，`chat.spec.ts` / `layout.spec.ts` 的 `model-option` 计数可能因组标题变化而需要修正——修正必须注明「基线变化，非回归」。
- 风险最高的是 Phase 3：`drainThread` 被所有 `manage.*` 命令共用，解码/换行语义一变，依赖 JSON 解析的命令（`PiCliRunner.parseJsonOrNull`、`authOverview`）可能连带受影响，故放最后并补齐全量回归。

## 验证命令

```
cd web && npm run typecheck
cd web && npm test                      # 基线 165
cd web && npx playwright test           # 基线 176，建议连跑两轮查 flaky
./gradlew test
./gradlew buildPlugin                   # 可选，真机安装前
```

真机目视：`MANUAL_TEST.md`「0.5.4 缺陷回归」段；截图/日志写入 `specs/0.5.4-run-report.md`（建档模式沿用 0.5.2/0.5.3，本批次不预建空模板）。
