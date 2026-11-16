# Feature Specification: 扩展包面板缺陷——市场链接白屏 + 假空态

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Draft（需求已收集、疑问已澄清；只产出 spec，不写 plan/tasks，不实现）

**Input**: 用户提出（2026-11-16）
> - 扩展包市场的链接点开弹窗白屏，还不如从默认浏览器打开
> - 扩展包进入显示"未安装任何扩展包。"，其实刚点进来是在加载中，应该先显示加载中之类的

两条都是扩展包面板的缺陷（行为错 / 状态错），合并一份规格交付，沿用 011「缺陷批次」的 spec 写法（现象 → 根因 → 期望行为 → 回归场景），不硬套业务价值叙事。

## 问题陈述（读码核实，非推测）

### 缺陷 1 — 市场链接点开白屏

| 项 | 内容 |
|---|---|
| 现象 | 扩展到「官方市场」页签，点卡片的 npm / 仓库链接 → 弹出一个**空白窗口**（白屏），而不是打开网页 |
| 复现位置 | `MarketplacePanel.tsx:287,291`：`npm` / `仓库` 链接用 `<a href={pkg.linkNpm/linkRepo} target="_blank" rel="noreferrer">` |
| 根因 | 宿主 `PiAgentPanel.kt:83-96` 只实现了 `CefRequestHandler.onBeforeBrowse`（导航拦截 → `BrowserUtil.browse` 转系统浏览器），**没有实现 `CefLifeSpanHandler.onBeforePopup`**。`target="_blank"` 会先由 CEF 创建一个空白 popup browser，随后导航才被 `onBeforeBrowse` 取消 → 留下一个白窗口 |
| 现成能力 | `BrowserUtil.browse(url)` 系统浏览器打开已在项目三处使用：`PiAgentPanel.kt:93`（链接拦截）、`PiLoginSupport.kt:233`（014 OAuth）、`PiPackages.kt:532` 附近（市场 URL 校验）。无需引入新机制 |

**结论**：低成本缺陷，修法方向明确——在系统浏览器这条既有通路上把 `_blank` popup 也接住（拦截 popup 打开、转 `BrowserUtil.browse`），或把市场链接改为不依赖 `_blank` 的显式桥接打开。具体选哪种属 plan 技术选型，spec 不锁定。

### 缺陷 2 — 进入面板假空态

| 项 | 内容 |
|---|---|
| 现象 | 刚点进「扩展包」面板，先闪现「未安装任何扩展包。」，随后列表才加载出来 |
| 复现位置 | `PackagesPanel.tsx:390-391`：`<div className="panel-empty">{result?.error ? result.error : t("package.empty")}</div>` |
| 根因 | `result` 为 `null`（首次加载尚未返回）与 `result` 为空数组（确实没装包）**共用同一个空态分支**：`result?.error` 为真走错误文案，否则一律 `t("package.empty")`。加载中被误判成「无数据」 |
| 现成能力 | 面板已有 `busy` 状态（`:124`，操作级互斥）与 `checks[index].loading`（`:240`，版本检测加载态）；i18n 有通用加载文案可复用或新增一条 |

**结论**：纯前端展示缺陷，给空态分支补一个「加载中」判据即可，无数据契约变化。

## User Scenarios & Testing

### US1 - 市场链接在系统浏览器打开，不再白屏 (P1)
扩展包 → 官方市场 → 点卡片的 npm 链接或仓库链接：网页在**系统默认浏览器**中打开（与消息里的普通链接、OAuth 授权页行为一致），JCEF 面板内**不再弹出空白窗口**，也不离开/刷新当前工具窗页面。链接无效或 `BrowserUtil.browse` 失败时不得白屏卡住，应有可感知的处理（如不拦截、留原链接可手动复制）。

### US2 - 加载中先显示加载态，不出假空态 (P1)
首次进入扩展包面板、`result` 尚未返回时：区域显示「加载中…」之类的明确加载态，**不得**显示「未安装任何扩展包。」。加载返回后才按真实结果切换：有包 → 列表；确实为空 → 空态；出错 → 错误文案。刷新（`:372 packages-refresh`）同样先回到加载态再出结果。

### US3 - 两种状态不串台 (P1)
- 网络/命令出错时显示错误文案，不被加载态或空态吞掉；
- 空列表（真正没装包）仍显示「未安装任何扩展包。」，不能因为加了加载态而永远显示「加载中」；
- 加载态不影响面板其它操作（页签切换、刷新按钮）的可用性。

## Requirements

- **FR-001** 市场卡片的 npm / 仓库链接 MUST 在系统默认浏览器打开，MUST NOT 在 JCEF 内弹出新的空白窗口或导航离开当前页面。
- **FR-002** 链接打开 MUST 复用现有 `BrowserUtil.browse` 通路（与 `PiAgentPanel` 链接拦截、`PiLoginSupport` OAuth 一致），MUST NOT 引入新的浏览器打开机制或 internal API（verifyPlugin 硬拒项）。
- **FR-003** 系统浏览器打开失败时 MUST NOT 留下无反馈的白屏；MUST 走既有降级（不拦截 / 保留可手动复制的链接）。
- **FR-004** 扩展包面板在列表数据首次加载、刷新期间 MUST 显示明确加载态，MUST NOT 显示「未安装任何扩展包。」。
- **FR-005** `result` 的三种状态 MUST 严格区分：加载中（null/未返回）→ 加载态；返回空 → 空态文案；返回错误 → 错误文案。三者 MUST NOT 互相串台。
- **FR-006** 加载态 MUST 复用面板已有的 busy/loading 语义与样式语言，不引入第二套视觉；新增文案 MUST 双语（en/zh）。
- **FR-007** 修复 MUST NOT 改变市场数据获取、`pi list` 解析、队列等既有逻辑（035/033 已交付行为零回归）。

## Decisions（用户已拍板）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 两条缺陷是否合并 | **合并 1 份 spec（037）**，同为扩展包面板缺陷，各自 US/FR，同批验收 |
| Q2 | 具体修法（popup 拦截 vs 桥接） | 留 plan 决定；spec 只锁定「系统浏览器打开、不白屏」的行为口径 |

## 待 plan 阶段决定的技术问题（本规格不锁定）

- 白屏修法：`CefLifeSpanHandler.onBeforePopup` 拦截转 `BrowserUtil.browse`，还是把市场链接改成显式桥接调用（避免 `_blank` popup 产生）。需真机确认 JCEF popup 生命周期。
- 加载态判据用 `result === null` 还是复用/新增独立 loading 标志位。

## 不做的事

- 不做市场数据获取逻辑的改动（检索、版本检测、registry 链沿用 033）。
- 不新增安装/升级/卸载能力（沿用 033 + 035 队列）。
- 不改其它面板的文件链接打开行为（消息内链接、OAuth 链接已正常，本条只修市场链接）。

## 与既有规格/事实的关系

- **复用 014** 的 `BrowserUtil.browse` 系统浏览器通路与 033 的 `PiPackages` 市场 URL 校验。
- **复用 003** 的「加载中 / 失败 / 空 / 不支持」状态区分原则——本条是该原则在扩展包面板的两个漏点。
- **不推翻** 035 的操作队列与 033 的任何行为契约。

## 验证计划（实现后填写，本规格仅列判据）

| 层 | 用例 | 期望 |
|---|---|---|
| 单测 | 市场卡片链接渲染 | 链接带正确 href；点击处理走系统浏览器通路，不产生 `_blank` 空白 popup |
| vitest | `PackagesPanel` 空态分支 | `result=null` → 加载态；`result=[]` → 空态文案；`result.error` → 错误文案，三者不串台 |
| e2e | mock 延迟返回扩展包列表 | 加载期间断言无「未安装任何扩展包」，出现加载态；返回后切换到真实内容 |
| 真机 JCEF | 点市场 npm / 仓库链接 | 系统浏览器打开网页，JCEF 内无空白弹窗，工具窗不刷新/不离开 |
| 真机 JCEF | 首次进入/刷新扩展包面板 | 先加载态后结果，无假空态闪现 |
| 静态 | verifyPlugin | 无 internal API 命中 |

## 开放问题

无阻塞项。两条疑问（缺陷组织、修法口径）已于 2026-11-16 拍板或明确留 plan。
