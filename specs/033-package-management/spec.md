# Feature Specification: 包管理完善——可操作清单 + 版本检测/一键升级 + 官方市场接入 + 无网快速失败

**Feature Branch**: `release/0.5.8-20261112`

**Created**: 2026-11-14

**Status**: Approved（2026-11-14 用户全权委托自动执行，Q1–Q8 全部按推荐默认关闭：Q1 单序、
Q2 tab、Q3 市场安装弹确认、Q4 关键词徽章、Q5 以 API 为准、Q6 预检读 npm registry 配置、
Q7 不做取消、Q8 pi 自更新不做）

**Input**: 用户提出（2026-11-14）
> 把包管理完善。进入包管理，展示本地安装的包，以可操作的列表清单形式展示，支持一键卸载、
> 一键检测版本、一键升级。还可以切换打开官方市场的列表清单（即官网上那个包的页面），
> 想办法把那个接过来。目前只能查到很多包的列表，支持一键安装。接时长的话，还要考虑有些环境
> 是没有网络的。如果点击的话，不要让它卡死，要能够在无网的情况下快速失败，给出友好提示。

**补充（2026-11-14）**：
> 内网环境有可能有自己的私服。初次使用在引导安装时可以选私服地址（028 的方向）。类似的，
> 可以指定自己的私服。像 Nexus 提供的 NPM 私服是不是也能实现这种市场插件的搜索？
> 要考虑国际和国内的网络情况，如果是国内的话，是不是选个国内的公服？

（「接时长的话」按上下文理解为「接市场的话」。）

**可行性结论（取证后）**：**可做，且审计发现两个现存缺陷必须随本条一起修**。
官方市场的数据源已实证可用（npm registry search API，与 pi.dev 同源，无需爬站）；
pi 1.5.0 的**单包更新命令是坏的**（三种写法全部 `No matching package found`），
但「检测版本 + 钉版重装」通路已实测可行；无网快速失败必须插件自建——`PI_OFFLINE`
管不住包命令，npm 断网实测 72s/144s 才失败，插件硬超时 300s。

证据全文：[`evidence/probe-033-packages.log`](./evidence/probe-033-packages.log)、
[`evidence/probe-033-packages.json`](./evidence/probe-033-packages.json)（17/17）。

## 问题陈述

### 现状

包管理面板（`PackagesPanel.tsx`）已有的能力：手输源串安装、行内「升级/卸载」、
「全部升级」（018）、确认框、双语。没有的能力与现存缺陷：

| # | 问题 | 证据 |
|---|---|---|
| 1 | 列表是 `pi list` 的**裸文本行**：无版本号、无状态、无作用域区分，谈不上「可操作的清单」 | `PackagesPanel.tsx:37-40` 前缀正则筛行；`pi list` 输出本身无版本（P3） |
| 2 | 行内「升级」按钮**对 pi 1.5.0 必坏**：传 `npm:xxx` 给 `pi update`，pi 报 `No matching package found`（三种写法全试过） | P8；`PackagesPanel.tsx:61-74` → `PiManage.kt:533` |
| 3 | 无网时安装/升级**长时间假死**：npm 重试梯队走满才失败（安装 72s、全部升级 144s），插件硬超时 300s 兜底，期间只有 busy 态 | P5/P7；`PiManage.kt:136,150-168` |
| 4 | 装失败（启动期安装失败、文件缺失）的包在面板里**看不出异常** | P13（源行缺路径行 = 失败态，纯本地可判定） |
| 5 | **没有官方市场入口**；pi.dev/packages 上 5397 个包只能去网站手动翻，复制命令回来手输安装 | pi.dev/packages（P16） |
| 6 | 「检测版本」不存在：不知道已装什么版本、也不知道有没有新版 | P14（版本可从解析路径 package.json 读，最新版可查 registry） |

### pi 侧能力（已实证，非推测）

| 命令/机制 | 实证结果 | 对本规格的意义 |
|---|---|---|
| `pi list` | 作用域标题 → 源行（`npm:openwiki`）→ 解析路径行；无版本号；断网 0.65s 正常 | 清单唯一数据源；路径行有无 = 安装成功/失败 |
| `pi install <source>` / `pi remove <source>` | 安装 25s（336 依赖）/ 卸载断网 3s；settings 写**不钉版**的源串 | 卸载离线可用；安装是市场一键安装的原语 |
| `pi update --extensions` | 在线 2.3s「Updated packages」；断网 144s 失败；机制 = 逐包 `npm install <name>@latest` | 「全部升级」保留；但无网必须预检拦截 |
| `pi update <source>`（单包） | **pi 1.5.0 损坏**：`npm:xxx` / 裸名 / `--extension` 三种写法全报 `No matching package found`（0.6s 即败） | 单包升级**不能**依赖它（FR-004 改道） |
| `pi install npm:<name>@<ver>` | 强制变更物理版本（0.8.0↔0.9.0 双向实测），settings 保持 `npm:openwiki` 不钉版 | **单包升级通路**：检测 latest → `install npm:<name>@<latest>` |
| 重装同名（不钉版） | **no-op**：`<agent>/npm/package-lock.json` 钉住上次解析结果，物理版本不动 | 「重装即升级」不成立，必须带版本号 |
| `PI_OFFLINE` / `--offline` | 只禁**启动期**网络操作；`PI_OFFLINE=1` 下 install 照样联网成功（4.4s） | 无网快速失败**必须插件自建预检**（FR-008） |
| 版本来源 | 已装 = 解析路径下 `package.json`（文件系统，离线可用）；最新 = registry `/-/latest` | FR-002/FR-003 的数据通路 |
| 启动期安装失败 | pi 官方文档：警告并跳过该包继续运行；`pi list` 源行无路径行 | 异常态可纯本地判定并展示（FR-002） |

### 市场与 registry 数据源（已实证 + 兼容性矩阵）

- pi 官方文档（pi 1.5.0 自带 `docs/packages.md`）：npm 包带 **`pi-package` 关键词**
  即有资格进入 **Pi package gallery（pi.dev/packages）**，可选 `pi.image`/`pi.video` 预览。
- pi.dev/packages 是 Vite SPA，卡片字段：名称、描述、作者、月下载量、最近发布、
  类型徽章（package/extension/skill/theme/prompt）、npm/GitHub 链接、安装命令示例。
- **npm registry search API 与站点同源**：
  `GET https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=50&from=N`，
  返回 name/version/description/keywords/author/date/downloads.monthly/links，
  首名（billion-context）与站点一致。分页 `size`/`from`，**无需爬 pi.dev 页面**。
- 数量口径：API total=13710，站点显示 5397——站点有未披露的过滤（Q5）。

**registry 兼容性矩阵（P19 实测/取证）**——市场检索与版本检测必须按 registry 适配：

| 端点 | npmjs 官方 | npmmirror（cnpmcore，国内公服） | Nexus 3（代理仓） | Nexus 3（hosted 私有仓） |
|---|---|---|---|---|
| `/-/v1/search?text=keywords:pi-package` | ✅ total 13710 | ⚠️ **空结果**（不解析 `keywords:` 语法） | ✅（2017 起 3.6+ 支持 npm search 端点） | 端点可用但几乎没有 pi-package 内容 |
| `/-/v1/search?text=pi-package`（纯文本） | ✅ | ✅ total 10000，首名 pi-subagents（模糊匹配） | ✅ | 同上 |
| `GET /<name>/latest` | ✅ | ✅ | ✅ | ⚠️ hosted 仓 `{name}/{version}` 端点有已知坑（nexus-public #224） |
| `GET /<name>` packument（读 `dist-tags.latest`） | ✅ | ✅（172KB/小包） | ✅ | ✅ |

结论（写进 FR-018/FR-019）：**不按厂商硬编码，运行时探测 + 降级**——
检索先试 `keywords:` 语法、空则退纯文本、再失败则「市场检索不可用」提示；
latest 检测以 `/name/latest` 为主路径、packument 兜底；认证类私服 401/403 降级为只显示已装版本。

### 插件侧挂载点（现成）

| 需求 | 现成位置 |
|---|---|
| HTTP 请求（市场检索 + registry 查询 + 连通预检） | `PiModels.kt:348` 先例：`java.net.http.HttpClient` + `connectTimeout`（公共 API，verifyPlugin 安全） |
| CLI 调用与硬超时 | `PiCliRunner`（waitFor 超时已有，报 "timed out after Ns"） |
| 结果展示 | `OutcomeBanner`（ok/fail 横幅）+ 001 FR-007 的 verbatim 输出契约 |
| 确认框/悬浮提示 | `ConfirmDialog`（007）、`Tooltip`（012） |
| 桥接 | `manage.packages*` 5 个 RPC 已存在，新增四处同步（FR-013） |

## User Scenarios & Testing

### US1 - 已装包以可操作的清单展示 (P1)

进入包管理，看到**列表清单**而非裸文本行：每行有来源串、已装版本、状态（正常 /
装失败）、作用域（全局/项目），行内操作：卸载、检测版本、升级。卸载有确认框（现状保留）。

### US2 - 一键检测版本 (P1)

点「检测版本」：npm 包显示「已装 x.y.z / 最新 a.b.c」并给出三态结论
（**已是最新 / 可升级 x→y / 无法检测最新（离线或网络失败）**）；git 来源显示
「按 ref 对齐，在线时可用升级」；本地路径来源显示「无版本概念」。

### US3 - 一键升级 (P1)

点行内「升级」：npm 包走 `pi install npm:<name>@<latest>`（pi 1.5.0 实证通路），
完成后显示 pi 输出原文（verbatim 契约）并刷新清单；「全部升级」保留
`pi update --extensions`。单包升级不再调用 pi 1.5.0 已损坏的 `pi update <source>`。

### US4 - 官方市场清单 (P1)

面板内切换到「官方市场」页签：分页列表（50/页）+ 搜索框，卡片展示名称、版本、
描述、作者、月下载量、最近发布、类型徽章、npm/GitHub 链接；一键安装（复用
`packageInstall`）；已安装的包显示「已安装」不可重复安装。市场只读消费
pi.dev/gallery 的数据源（npm `pi-package` 关键词），不做登录/发布。

### US5 - 无网快速失败，不卡死 (P0)

断网环境下：点市场浏览/搜索 → ≤5s 出现友好提示（「网络不可达……请检查网络或代理」），
不发起 npm 长命令；点安装/升级 → 预检失败即时提示，**不进入 72s/144s 的 npm 重试
或 300s 硬超时**；点检测版本 → 显示已装版本 + 「无法检测最新」；清单刷新与卸载
**照常可用**（纯本地，实测 0.65s / 3s）。所有等待均有明确 loading 态。

### US6 - 装失败的包可见可修复 (P2)

`pi list` 源行无路径行的包在清单中标为「安装失败/文件缺失」，行内提供「重装」
（同源重跑 `pi install`），不再混在正常列表里看不出异常。

### US7 - 私服与国内镜像（registry 配置）(P1)

内网用户在设置面板把 registry 指向自己的私服（如 Nexus）后：市场浏览（若私服支持
检索）、版本检测、连通预检全部走私服；安装/升级的 npm 子进程被注入同一 registry，
**不修改用户的 `.npmrc`**。国内用户可一键选 `registry.npmmirror.com`（国内公服）：
版本检测立即可用，市场检索自动降级为纯文本模糊匹配（npmmirror 不支持 `keywords:`
语法，P19）。私服若需认证导致元数据 401/403：检测降级为只显示已装版本并给出友好
说明，安装仍可尝试（npm 自身带 .npmrc 认证）。跟随 npm 配置（默认）时行为与官方
registry 完全一致。

## Requirements

- **FR-001** 清单 MUST 以 `pi list` 为唯一数据源，解析出：作用域（User/Project 段标题）、
  源串、解析路径（源行下一行的 4 空格缩进行）；MUST NOT 自行枚举 `<agent>/npm/node_modules`。
- **FR-002** 每行 MUST 展示：源串（mono）、已装版本、状态、作用域。已装版本从解析路径下
  `package.json` 读取（文件系统，离线可用）；**源行缺路径行 MUST 判定为「安装失败/文件缺失」**
  （P13）。读取失败降级显示「未知版本」，不得让整表渲染失败。
- **FR-003** 「检测版本」MUST 拆为两端：已装版本（本地读，永远可得）+ registry latest
  （网络，预检守护，npm 包走 `registry.npmjs.org/<name>/latest`）。结论三态：
  已是最新 / 可升级 x→y / 无法检测最新（并注明原因）。git 来源标注「按 ref 对齐」，
  本地路径来源标注「无版本概念」。
- **FR-004** 单包升级：npm 包 MUST 走 `pi install npm:<name>@<latest>`（latest 取自 FR-003
  的检测结果；检测失败时不盲升——提示先检测）。git 包走重装同源；本地路径包升级按钮禁用。
  **MUST NOT 调用 `pi update <source>`**（pi 1.5.0 实证损坏）。单包升级成功后 MUST 刷新清单并重读版本，
  且 MUST 校验物理版本已变为目标版本（防止 P9 类 no-op 假成功——本方案带版本号，不受 lock 影响，
  此校验为保险）。settings 的不钉版性质 MUST 保持（现状即如此，P10/P11 实证，无需额外处理）。
- **FR-005**（2026-11-14 P21 追加：类型过滤 = 多一个 keywords: 限定符的服务端过滤，chips 行 全部/扩展/技能/主题/提示词；npmjs 精确、镜像端纯文本近似；类型来自 pi-* 关键词推断，与官网 manifest 索引口径有差。取证 P21：官方首页徽章分布 extension 23/package 24/prompt 1/skill 1/theme 1；多 keywords AND total=6451）
- **FR-005** 官方市场 MUST 直连 npm registry search API
  （`/-/v1/search?text=keywords:pi-package[+ 搜索词]`，分页 `size`/`from`，50/页），
  **MUST NOT 爬取 pi.dev 页面**。搜索框 MUST 转化为 API text 参数追加检索词。
- **FR-006** 市场卡片 MUST 展示：名称、版本、描述、作者、月下载量（千分位，与 031 口径一致）、
  最近发布时间、npm 页与仓库链接（IDE 浏览器打开）。类型徽章按 `pi-*` 关键词推断
  （`pi-extension`→extension 等），无匹配关键词时显示「package」（Q4）。
- **FR-007** 市场卡片 MUST 标记「已安装」并禁用安装按钮：判定 = 与已装清单的 npm 包名一致
  （源串 `npm:<name>` 归一化后比对，忽略版本后缀）。
- **FR-008** 所有网络操作（市场浏览/搜索、安装、升级、latest 检测）MUST **先做连通预检**：
  预检失败（≤5s 内不可达）MUST 立即终止并展示友好文案（主文案人话 + 「检查网络或代理设置」指引），
  **不得**继续 spawn npm/pi 长命令（P4/P5/P7：PI_OFFLINE 管不住包命令，npm 断网 72s/144s）。
  预检目标与镜像兼容见 Q6。
- **FR-009** 预检通过后，进程级硬超时 MUST 保留（沿用现有 300s）作为兜底；HTTP 请求本身
  MUST 带独立总超时（市场检索 ≤15s、latest 查询 ≤10s），超时按失败处理并复用 FR-008 文案。
- **FR-010** 本地操作（清单刷新、版本读取、卸载）MUST 无网完全可用（P12），MUST NOT 触发预检。
- **FR-011** 网络 MUST 走 `java.net.http.HttpClient`（公共 API，先例 `PiModels.kt:348`），
  MUST NOT 使用 internal API（verifyPlugin 硬拒）；所有网络/CLI 调用 MUST 在后台线程，
  不得阻塞 EDT。
- **FR-012** UI MUST NOT 卡死：保留现有 busy 互斥（一次一个操作），但 busy MUST 有明确的
  操作级 loading 指示（哪个操作在跑）；面板/页签切换不被 busy 禁用；MUST NOT 新增长等待
  且无反馈的状态。是否加「取消」按钮见 Q7。
- **FR-013** 新增桥接（市场检索、版本检测、预检）MUST 四处同步：
  `bridge/types.ts` → `manage.ts`/调用方 → `BridgeService.kt` → `bridge/mock.ts`；
  mock MUST 能模拟：正常分页数据、预检失败（离线）、latest 查询失败，供 e2e 断言
  「快速失败」（断言提示出现时间/顺序，不依赖真机网络）。
- **FR-014** 新增用户可见文案 MUST 双语（en/zh）；npm 错误墙 MUST NOT 原样甩在主文案区——
  主文案给人话（如「安装失败：网络不可达」），CLI 原始输出折叠进可展开的「详情」区
  （verbatim 契约保留，001 FR-007 不推翻，只是加了层级）。
- **FR-015** install/update 成功与否的判定 MUST 保持 pi 输出 verbatim 展示（沿用 001 契约），
  本规格不新增「diff 安装状态」逻辑（FR-004 的版本校验除外）。
- **FR-016** registry 解析链（市场检索、latest 检测、连通预检共用）：**显式设置 >
  `npm config get registry`（进程内缓存）> 默认 `https://registry.npmjs.org`**。
  设置项支持预设（官方 / `registry.npmmirror.com` 国内公服）与任意自定义私服 URL。
- **FR-017** registry 设置为显式 URL 时，安装/升级触发的 CLI 子进程 MUST 注入
  `NPM_CONFIG_REGISTRY` 环境变量（npm 原生读取，pi 派生的 npm 子进程继承），
  **MUST NOT 改写用户的 `.npmrc`**；跟随模式 MUST NOT 注入。
- **FR-018** 市场检索 MUST 按端点探测降级（P19）：先 `text=keywords:pi-package[+词]`，
  结果为空且未带搜索词时退纯文本 `text=pi-package[+词]`；端点 404/401/超时则市场
  「检索不可用」友好提示（注明安装与版本检测不受影响）。探测结论 MUST 按 registry
  URL 缓存，避免每次翻页重试三连。
- **FR-019** latest 检测 MUST 以 `GET <registry>/<name>/latest` 为主路径，404 时以
  packument（`GET <registry>/<name>`，`Accept: application/vnd.npm.install-v1+json`）
  的 `dist-tags.latest` 兜底（Nexus hosted 仓 `/name/version` 端点有已知缺陷）；
  401/403 降级为「无法访问私服元数据（可能需要认证）」，仅显示已装版本。
- **FR-020**（2026-11-14 用户实测反馈追加）操作保持**单飞**——并发 pi install/remove 会撞两把无锁写（`<agent>/npm`：npm 对同一 prefix 无跨进程锁，node_modules/lockfile 互相踩；`settings.json`：pi 读改写、并发回丢条目）——但正在执行的行 MUST 高亮（accent 边框）并显示**专属进度线**（滑动假进度 + 「正在安装/移除/升级/重装…」文案），工具栏级操作（手输安装、全部升级）与市场卡片同理；用户 MUST 能分辨**哪一行、哪个操作**在跑，而不是整片无差别禁用。

## Decisions（待拍板——每条已给推荐默认）

| # | 问题 | 选项 | 推荐默认 |
|---|---|---|---|
| Q1 | 市场排序 | a. 相关度（npm 默认，与站点默认序一致，首名双侧同为 billion-context） b. 加「按下载量/最近发布」切换 | **a**——单序不做切换，减少状态面 |
| Q2 | 市场入口形态 | a. 面板内 tab（「已安装 \| 官方市场」） b. 上下分区滚动 | **a**——用户原话「切换打开」即页签语义 |
| Q3 | 市场一键安装是否弹确认框 | a. 弹（第三方包=任意代码执行，pi 官方文档明示 review source；展示完整来源串） b. 不弹（与现手输安装一致） | **a**——市场安装弹确认，手输安装沿用现状不弹 |
| Q4 | 类型徽章口径 | a. `pi-*` 关键词推断，缺省「package」（快，可能缺） b. 按页逐包拉 `/latest` 看 `pi` manifest（准，每页 +50 请求） | **a**——b 的延迟与请求量不值得 |
| Q5 | 数量口径（API 13710 vs 站点 5397） | a. 以 npm API 为准（更全，市场完整性优先） b. 试图复刻站点过滤（口径未披露，逆向脆弱） | **a** |
| Q6 | 预检目标 | a. 读 `npm config get registry`（缓存），预检指向用户实际 registry——镜像用户不误判 b. 固定 `registry.npmjs.org`——简单，但配了国内镜像的用户会被误判离线 | **a**——已并入 FR-016 的 registry 解析链（显式设置 > npm 配置 > 默认） |
| Q7 | 长操作「取消」按钮 | a. 本轮不做（预检 + 短超时已保证无网 ≤5s 失败；在线安装 25s 量级可等） b. 做（需 Kotlin 侧进程 kill + 状态回滚，影响面大） | **a**——预检已消掉「卡死」主因，取消留待真需求 |
| Q8 | pi 本体自更新（`pi update --self`） | a. 不做，另立需求 b. 顺带加（CLI 原生支持，接入成本低） | **a**——本条聚焦包管理，自更新涉及插件更新语义，另议 |
| Q9 | registry 配置的形态与位置 | a. 设置面板一项：「跟随 npm 配置（默认）」或显式 URL + 预设按钮（官方 / npmmirror）；安装注入 `NPM_CONFIG_REGISTRY`，不改 `.npmrc`；028 引导安装将来复用同一设置项 b. 只影响市场检索，安装仍走 npm 自身配置（会出现「市场能看装不上」的割裂） c. 读写用户 `.npmrc`（越权，风险高） | **a**——统一解析链（FR-016）+ 环境注入（FR-017），2026-11-14 随私服需求一并拍板 |

## 已知缺口（多排序，2026-11-14 P20 取证）

pi.dev/packages 的三种排序（Most downloads / Recently published / A-Z）本地**无法真实现**：npm search API 无 sort 参数且权重参数实测无效（popularity=1 与默认序逐位相同）、cnpmcore 忽略权重且无 keyword 目录端点（404）、pi.dev 为服务端渲染 HTML 无公开 JSON API（复用=爬 HTML=FR-005 红线）。折中：市场页签提供「在 pi.dev 排序浏览 ↗」直通链（官方页三种排序开箱即用）；本地保持相关度单序——对分页结果做页内排序是假排序（跨页乱序），宁缺毋滥。等 npm search 加 sort 参数或 pi.dev 开放 JSON 后一行接入。

## 不做的事

- **不做包详情页/README 渲染**：卡片链接跳 npm/GitHub（IDE 浏览器打开），详情即官网。
- **不做版本降级与钉版 UI**：升级只对齐 latest；`install @<ver>` 的钉版能力已实证存在但无 UI。
- **不做 pi.dev 登录/发布/收藏**：市场只读消费。
- **不做 git/local 包的市场发现**：市场只覆盖 npm 来源；git/local 的已装管理走清单行。
- **不做自动定时检查更新**：全部手动触发（检测版本按钮、刷新）。
- **不做包内资源开关**（`pi config` 的 extensions/skills/prompts/themes 启停）：TUI 已有，另立需求。
- **不爬 pi.dev 页面**（FR-005）；**不碰 `<agent>/npm/node_modules` 直接装/删**（全部经 pi CLI）。
- **不改写用户的 `.npmrc` / 不做 registry 认证管理**（FR-017）：HTTP 元数据请求不带凭据，
  需认证的私服从 npm 自身的 `.npmrc` 拿 token 装包；元数据 401/403 时友好降级（FR-019）。
- **不做多 registry 聚合搜索**：一次只面对一个解析出的 registry。

## 与既有规格的关系

- **修订 001 US2/US3 的实现事实**：单包「升级」机制从 `pi update <source>` 改为
  检测 + `install npm:<name>@<latest>`（pi 1.5.0 前者损坏，P8）；001 FR-007 的
  verbatim 输出契约**不推翻**，FR-014 只是给它加了「人话主文案 + 详情折叠」层级。
- **018 US6「全部升级」不变**（`pi update --extensions` 在线实测正常，P6），只加预检。
- **复用 001 的 `packageInstall`** 作为市场一键安装与 US6 重装的原语。
- **031 口径沿用**：下载量千分位；**012 的 Tooltip/ConfirmDialog** 沿用。

## 验证计划

已回填（run-report 第 16/17 节，探针 14/14 + CLI 链路 T1–T7 + 双套件基线）。

| 层 | 用例 | 期望 | 结果 |
|---|---|---|---|
| 单测 | `pi list` 输出解析（有包/无包/装失败/Project 段） | 源/路径/作用域正确，缺路径行判失败 | ⬜ |
| 单测 | 版本读取（package.json 存在/缺失/损坏） | 正常/「未知版本」降级，不抛 | ⬜ |
| 单测 | 预检状态机（可达/拒绝/超时） | ≤5s 失败，不 spawn CLI | ⬜ |
| 单测 | 市场数据映射（search API 样本 → 卡片字段/徽章/已装判定） | 字段齐全，`npm:name` 归一化比对 | ⬜ |
| 单测 | registry 解析链（显式 > npm 配置 > 默认）与 `NPM_CONFIG_REGISTRY` 注入 | 跟随模式不注入，显式模式注入 | ⬜ |
| 单测 | 检索端点降级（keywords 空 → 纯文本 → 不可用）与 latest 双路径（/latest 404 → packument） | 降级顺序正确，结论缓存 | ⬜ |
| vitest | 前端组件（清单行、市场卡片、页签切换、离线文案） | 双语键齐全，三态结论正确 | ⬜ |
| e2e | mock：市场分页/搜索/已安装禁用 | 卡片字段与禁用态断言 | ⬜ |
| e2e | mock：预检失败 → 友好提示快速出现；无 npm 错误墙裸奔 | 提示出现且主文案不含 npm error 原文 | ⬜ |
| e2e | mock：私服场景（检索不可用 / latest 401）降级提示 | 市场提示不可用、检测只显示已装版本 | ⬜ |
| 真机 | 断网：市场/安装/升级/检测逐一点击 | 各 ≤5s 友好失败；清单与卸载照常 | ⬜ |
| 真机 | 在线：检测版本→升级→版本号变化→settings 仍不钉版 | 物理版本变化，清单刷新 | ⬜ |
| 真机 | registry=npmmirror：检测版本与市场检索降级 | /latest 生效，检索退纯文本可用 | ⬜ |
| 真机 | 装失败包（settings 加伪源）显示异常态并可重装 | US6 | ⬜ |
| 静态 | verifyPlugin | 无 internal API 命中 | ⬜ |
