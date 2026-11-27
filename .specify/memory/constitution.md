# Pi Agent for JetBrains Constitution

> 本文件是本仓库所有 spec / plan / tasks 的约束基准。任何与本文冲突的实现方案，
> 必须先修订本文（走 Governance 流程），再改代码。
> 每条原则后面的「来源」指向真实踩过的坑，不是凭空立的规矩。

## Core Principles

### I. 双端契约同步（NON-NEGOTIABLE）

任何同时存在于 Kotlin 侧与 web 侧的**默认值、枚举、字段名、状态机**，必须在同一次变更里一起改，
且以 `web/src/store/types.ts` 与 Kotlin 的数据类作为唯一真源。

- 默认值（审批模式、自动压缩、自动重试、主题偏好）改动时，必须同时更新：
  Kotlin 侧策略/偏好读写、web 侧 store 初始值、以及 mock（`bridge/mock.ts` / `mock-pi.mjs`）。
- 新增字段必须先落到 `types.ts` 的类型定义，再实现桥接与 UI；不允许只在 UI 侧临时拼字段。
- 跨端持久化结构必须带版本号，读取旧版本时做一次性迁移，迁移后保留用户此前的显式选择。

**来源**：v0.4.0 审批策略翻转时，JS 侧与 Kotlin 侧默认值不同步会导致「UI 显示 Auto-approve ON，
但扩展仍在 ask」，用户看到的状态与实际行为不一致。

### II. 验收断言必须包含几何与行为，不允许只断言存在

`toBeVisible()` / `toBeTruthy()` 只证明「有一个非空包围盒」，不证明用户看得见。
凡是涉及布局、弹层、浮层、滚动容器的改动，验收必须断言：

- 元素的 rect 落在其容器（通常是 `.app`）内，四个边界都要检查；
- 需要同轴的组件，断言 `left` / `width` / 中心点的数值相等（容差 < 0.5px）；
- 页面级 `scrollWidth === clientWidth`；
- 弹层与触发器的相对位置（在触发器上方/下方、不遮挡输入框）。

纯逻辑改动至少要有单元测试；没有断言覆盖的改动不得标记完成。

**来源**：UI_ISSUES.md 的 8 条问题里，「菜单被画到工具窗口外」「卡片右侧被裁」
「空态图标偏右」全部在 `toBeVisible()` 下绿灯通过，一路活到发版才发现。

### III. 布局不得依赖运行时环境假设

CEF / JCEF / 浏览器三者的滚动条宽度、`scrollbar-gutter` 支持度、`container-type` 的
包含块行为都不一致。因此：

- 不得用「滚动条刚好 N px」这类推算来做对齐，横向内缩一律写显式值；
- 需要按可用空间定位的弹层，必须在打开时实测容器 rect 再决定位置，不靠固定断点猜；
- 居中链路的所有祖先都必须有 `min-width: 0` / `max-width: 100%` 保险，
  防止某个宽子元素把包含块撑开导致 `margin: auto` 偏心；
- 不允许用 `overflow: hidden` 掩盖溢出当作修复——那只是把症状藏起来。

**来源**：`.message-list` 曾用 `6px + 10px gutter` 推算与输入框同轴，遇到 CEF 17px
经典滚动条时错位 1~17px；同一根因也让空态图标偏右。

### IV. 对 pi 生态的写操作必须可回滚、可解释

插件对用户 `~/.pi/agent/` 下的任何文件写入（settings.json、models.json、mcp.json、
skills、安装/卸载扩展包）都视为高风险操作：

- 写入前必须备份（沿用 `settings.json.bak` 约定），备份失败即中止写入；
- 结构化文件写入前必须本地校验（JSON parse 通过才落盘）；
- 失败必须把 stderr / 退出码原样呈现给用户，不允许吞掉后只显示「失败」；
- 只读场景一律优先用 `--json` 输出解析，不用文本抓取；pi 不支持的子命令要显式降级并提示版本要求。

**来源**：扩展包 / MCP / 设置面板的每一次破坏性动作都直接动用户的全局配置，
一次静默失败就可能让用户的 pi 在终端里也起不来。

### V. JCEF 是单向的：不要向其中注入 JS，通信走 HTTP bridge

- 前端资源通过 `LocalUiServer` 以 loopback HTTP 提供，宿主与页面的通信只走
  `POST /bridge` + `GET /bridge/poll` 长轮询；
- 每个项目一个随机 token，配合 Origin 校验与 body 上限，不接受跨源请求；
- 桥日志不得记录信封内容（可能含用户代码与凭据）；
- 新增桥接方法必须在 `BridgeService` 与 `web/src/bridge/types.ts` 同时声明，
  fire-and-forget 类通知（`notify` / `setStatus` / `extension_ui_response`）不得走请求关联通路。

**来源**：早期用 JCEF `executeJavaScript` 注入传递消息不可靠，已整体弃用；
`extension_ui_response` 被误当请求发送会让 pi 的对话框死等。

### VI. 凭据零托管

插件自身不存储、不缓存、不打印任何 API Key / OAuth token。
凭据一律由 pi 自身管理（`auth.json` / `models.json`），插件只读取**键名与就绪状态**，
不读取值。UI 上任何展示凭据的位置只显示掩码。

**来源**：产品 Non-goals 明确条款；另有一次 `@Data + @ToString` 导致 secret 进日志的事故教训。

## 技术约束

- **构建**：Gradle + IntelliJ Platform Gradle Plugin 2.19.0；JDK 21 编译；
  支持区间 `sinceBuild=233` / `untilBuild=263.*`，编译基准固定为最低支持线，保证全区间二进制兼容。
- **实现语言**：宿主逻辑 Kotlin（少量必须用 Java 的扩展点除外）；前端 TypeScript + React + Vite。
- **前端产物**：`web/dist` 由 Gradle 任务同步进插件资源，不允许手工拷贝；
  JCEF 里出现旧 UI 时先怀疑产物过期。
- **pi 交互**：会话走 `--mode rpc` 子进程 + JSONL 分帧；一次性任务走无头 CLI
  （`--print --no-session --no-tools --no-mcp -ne -ns -np -nc`），不得污染用户会话。
- **图标**：工具窗口图标必须是纯描线、无填充底色的单色 SVG（颜色写在各 `<path>` 上），
  并配套 `_dark.svg`。品牌徽章式（彩色底 + 白描线）在 New UI 的 `toStrokeIcon` 下会退化成色块。
- **动作注册**：`<actions>` / `<group>` 必须放在 plugin.xml 顶层 `<actions>` 节内，
  写进 `<extensions>` 会被描述符解析器静默忽略。

## 开发流程

1. **每个功能先有 spec**：`specs/<YYYYMMDD-HHMMSS>-<topic>/spec.md` 写清用户价值与可验收行为，
   不含技术选型；技术方案进 `plan.md`；可执行步骤进 `tasks.md`。
   目录命名规则见下文「编号与命名」及 [`docs/SPEC_NUMBERING.md`](../../docs/SPEC_NUMBERING.md)。
2. **任务粒度**：单个 task 必须能在一次提交内完成并通过验证，且自带「怎么验」。
3. **实现顺序**：先补自动化断言，再改实现；断言红 → 实现绿。
4. **真机验收不可连续跳过两版**：纯自动化可以证明前端行为，但 IDE 侧扩展点注册、
   右键菜单可用性、JCEF 渲染差异只能真机确认。跳过需在 CHANGELOG 里显式记账。
5. **变更记账**：任何影响用户可见行为的改动必须进 CHANGELOG「未发布」段，
   破坏性或默认值变更需写明迁移方式。

## 编号与命名

自 2026-11-27 起，新工作的 spec 目录一律用时间戳前缀；三位流水号冻结为历史编号。
完整条文、动机与迁移边界见 [`docs/SPEC_NUMBERING.md`](../../docs/SPEC_NUMBERING.md)。

- **N1 目录名**：新 spec 目录 = `<YYYYMMDD-HHMMSS>-<topic-slug>`；时间戳取立项时刻；
  同一秒内开工则加 `-2`/`-3` 后缀。建目录用 Speckit 的 `--timestamp`，**不要用默认取号**
  （默认取号靠扫本地目录取最大号，并行 PR 必撞）。
- **N2 主题 slug**：小写英文字母 + 连字符，2–3 个词，与 spec 里的功能名一致。
- **N3 对外引用号**：GitHub issue 或 PR 号（两者共用一个计数器），写在 spec 头部
  `GitHub Issue:` / `GitHub PR:` 字段；主号取先落地的那个，需求单 issue 优先。
  **号不进任何文件名**；正文按 GitHub 原生写法 `#N`，文件名里连 `#` 都不能带
  （Markdown 会把它当 fragment，链接静默失效）；引用的是**上游仓库** `57ggfk/pi-agent-idea`
  的号——fork 的 issue 计数会重排。
- **N4 changelog 碎片**：`<时间戳>-<主题>.<added|changed|fixed>.md`。文件名不进发布说明，
  长度不限，但必须是 slug 形态（小写字母 / 数字 / 连字符），否则 CI 挡下。
- **N5 提交信息**：不带编号；引用 issue 用 GitHub 原生 `(#N)`。
- **N6 存量三位号（001–070）只读**：不再新增、不再扩展、不重命名；
  旧号 → 新号映射见 `docs/SPEC_NUMBERING.md` §7。
- **N7 不协调取号**：任何情况下都不需要与他人协调才能开工——这是本节存在的理由。

## Governance

- 本宪法优先于任何 `plan.md` / `tasks.md` 中的临时决定；冲突时以本文为准。
- 修订需满足：说明动机（最好附真实故障）、更新受影响的 spec、在 CHANGELOG 记录。
- 版本语义：MAJOR = 删除或反转既有原则；MINOR = 新增原则或约束；
  PATCH = 措辞澄清。
- 每次 `/speckit.analyze` 必须显式检查 plan 与本文的冲突项，冲突即阻断。

**Version**: 1.1.0 | **Ratified**: 2026-11-02 | **Last Amended**: 2026-11-27
