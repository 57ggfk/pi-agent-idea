# 手工验收清单（真机 IDEA）

> 插件：Pi Agent v0.5.0 · 目标：IntelliJ IDEA 2023.3+（全系 JetBrains IDE，233–263.\*）
> 前置：本机装有 pi（`pi --version`）；IDEA 可用任意模型配置。

## 安装

- [ ] `Settings → Plugins → ⚙ → Install Plugin from Disk…` 选择 `build/distributions/pi-agent-idea-0.5.0.zip`（或直接解压到插件目录：macOS `~/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/`，Windows `%APPDATA%\JetBrains\IntelliJIdea2026.2\plugins\`，Linux `~/.local/share/JetBrains/IntelliJIdea2026.2/plugins/`）→ 重启 IDE
- [ ] 重启后 `Settings → Plugins` 中出现 **Pi Agent**，无加载报错（`Help → Show Log` 无 SEVERE）

## Chat（对话）

- [ ] 右侧边栏出现 **Pi Agent** 工具窗（图标为蓝色 π 徽标），打开后显示空态（模型名 · provider）
- [ ] 顶栏模型选择器列出可用模型；思考等级选择器显示当前模型支持的档位
- [x] 发送一条消息 → 流式 markdown 渲染（代码块有高亮，右上角有 **Copy** 按钮）
- [ ] 消息里的 markdown 链接点击 → 用系统浏览器打开（工具窗不导航走）
- [ ] 消息中出现 `file.kt:12` 形式引用 → 点击跳到编辑器对应行
- [ ] 触发一次工具调用 → 出现工具卡片；edit/write 调用显示红绿 **diff 视图**
- [ ] 发送图片 → 自己的消息气泡里图片**回显**；会话回放时图片也显示
- [ ] 输入 `@` → 出现文件补全浮层（输入关键词过滤，↑↓/Enter 选择，Esc 只关菜单）；无匹配时显示 `No matching files`；`@` 紧跟中文（如 `看@src`）也能弹出
- [ ] 拖拽一张图片文件到输入框 → 和粘贴一样出现图片 chips
- [ ] 运行中发送第二条消息 → 出现 Steer/Follow-up 模式选择；选择后消息进入输入框上方的**队列条**（不再是只有数字的提示）
- [x] 点击 **Stop** → 中止；输入框恢复 Send
- [ ] 输入 `/` → 命令补全菜单（扩展命令/模板/skill）；Tab 选中后自动补全；无匹配时显示 `No matching commands`
- [ ] 底部状态栏：运行状态点、pi 版本、ctx 百分比、成本、消息数
- [ ] 顶栏 **Compact** → 系统条目显示压缩前后 token
- [ ] 顶栏 **+ New** → 清空会话；**运行中点 + 会先弹确认框**，取消则当前回复继续
- [ ] ⚙ **Options** 菜单在 360 / 430 / 900px 宽度下都能完整展开：三个开关可点、Theme 三个分段都在、不越出工具窗

## 消息操作（v0.5.1 新增）

- [ ] 悬停任意 user / assistant 消息 → 上沿浮出操作条；移开消失；**消息位置不跳变、列表不出现横向滚动条**；窄工具窗（约 360px）下操作条也不越出窗口
- [ ] 悬停**正在流式输出**的那条 Pi 消息 → **没有**操作条；流式结束后出现（内容还在变时不做复制）
- [ ] 点 **Copy** → 粘贴到编辑器：Pi 消息是 Markdown 源码（``` 围栏、列表符号都在），**不含** thinking 文本、工具卡片内容；user 消息是原文（换行原样）
- [ ] 复制成功后按钮变 ✓ 约 1 秒后恢复；失败显 ✗（JCEF 下异步剪贴板不可用时应自动降级，仍能复制成功）
- [ ] 错误的系统条目（如发送失败）也能悬停复制，且没有「引用/重新生成」
- [ ] 点 **Quote** → 输入框出现 `> ` 前缀的引用块，光标在末尾；若输入框已有草稿 → **草稿保留**，引用追加在其后
- [ ] 悬停**最后一条** Pi 回复 → 有 **Regenerate**；点它 → 旧回复消失，新回复流式出现；Sessions 列表多出一条分支会话，旧会话文件仍在可切回
- [ ] 悬停**最后一条** user 消息 → 有 **Edit**；点它 → 输入框回填原文、上方出现黄色 `Editing message` 徽标 → 改完发送 → 该消息内容更新、旧回复消失、新回复流式到达
- [ ] 编辑态按 **Esc**（或点徽标右侧 Esc）→ 输入框清空、徽标消失、**消息列表完全不变**（此时 pi 侧尚未分叉）
- [ ] 运行中：历史消息仍可复制/引用，但 **Regenerate / Edit 都不出现**（同一时刻只允许一个历史改写操作）

## 消息队列（v0.5.1 新增）

- [x] **queue_update 真的会到**：运行中排队 2 条追加 → 输入框上方的队列条出现 2 个条目（序号 1/2、`追加` 徽标、120 字预览）；在终端里对同一个 pi 进程 `steer` 一条 → 队列条**实时**多出该条目（`queue_update` 是真实事件，不是 mock 假象）
- [ ] **图片只认插件镜像**：带图条目入队 → 条目有图片计数；在终端触发一次外部改动（如再排一条）→ 队列条顶部出现「队列已被外部修改，已按 pi 重建」，重建后的条目**无图片**（pi 的队列取不回图片，这是如实呈现不是 bug）
- [x] **按序执行归 pi**：两条追加排队 → 第一轮结束后第二条自动作为新一轮执行，队列条剩 1 条且序号重排为 1；全程**不需要**插件代发（排空后消息列表正好 3 轮 user 消息）
- [x] **取回编辑**：点条目 ✎ → 该条从队列消失，文本与图片回到输入框（草稿非空时追加在后，不覆盖）；改完再发 → 重新入队
- [x] **排序与删除**：↑↓ 相邻交换（首条 ↑ / 末条 ↓ 禁用）；✕ 首点变「确认删除 / 取消」且 2.5 秒无操作自动还原，再点才真删
- [x] **插话**：运行中以 Steer 模式发送 → 消息流立刻出现带「插话」徽标的 user 消息（渲染的是 fire 动作），队列条该条目随 pi 注入逐条减少；空闲时 Steer 发送直接成为新一轮，不入队
- [ ] **插话失败**：断网或让 steer RPC 失败 → 条目回到队列并标红显示原始错误，**不静默丢失**
- [ ] **提升**：对队列里的追加条目点 ⇧ → 它立即按插话 fire，其余条目顺序不变
- [x] **abort 暂挂**：队列非空时点 Stop → 队列条出现「运行已中断，队列暂挂」横幅与 继续/清空；**暂挂期间没有任何新 turn**；点继续 → 按原序重新排队继续执行（错过的补发时间不回来，这是如实语义）
- [ ] **pi 重启暂挂**：队列非空时重启 pi（或 pi 崩溃）→ 队列保留并显示「pi 已重启，队列暂挂」，不自动 fire
- [x] **切会话确认**：队列非空时切/新建会话 → 先确认「将丢弃 N 条排队消息」，取消则队列原样；确认后才清空
- [x] **webview 重载恢复**：排队后 reload 工具窗（或重开工具窗）→ 队列条目、顺序、暂停状态完整恢复（Kotlin 侧镜像是恢复源）

> **真机验证记录（2026-11-04 凌晨，WebStorm 2026.2 + 真 pi 1.4.0 + openrouter/free）**：
> 通过 CDP 驱动真实 JCEF webview 自动化完成，截图存于 `%TEMP%\ide-rt\`。已验证：基础聊天、
> 真实 queue_update 全链路（两条追加 + 图片条目 + 序号/徽标/预览）、abort 暂挂与继续、
> **暂停态整理队列**（取回编辑/上移/边界禁用/确认删除——此组用例直接暴露并修掉了
> 「暂停态操作抹掉镜像」的数据丢失洞）、**webview 重载恢复**（Kotlin 镜像按整理后顺序还原 +
> 暂挂横幅）、插话徽标与消费排空、切会话确认、MCP 完整生命周期（添加→停用落盘
> `enabled:false`→启用删键→删除，机器状态已还原）、Packages/Auth/Diagnostics 面板渲染、
> 环境区 pi 1.4.0 + Update 入口。另有两个 RPC 级真机探针结论：空闲 follow_up 永不自启
> （resume 已改为首条直发）、get_state 流式中不含 isStreaming（改由 agent_start/agent_settled
> 事件跟踪）。未真机验证（留人工）：外部改动导致 drift 的图片归属、插话失败标红、
> pi 重启暂挂、提升的 steer 段可视瞬间（free router 消费过快，快照窗口 <1s，已由
> Kotlin 单测覆盖）、2.5s 删除确认自动还原（e2e 覆盖）。

## 静默失败可见化（v0.5.1 新增）

- [ ] pi 还在启动时立刻输入 `@` → 菜单显示「Loading files…」（或已有文件列表），**不再**显示「No matching files」
- [ ] 停掉 pi 后输入 `@` → 菜单显示 **Failed to load files** + 一行原因 + **Retry**；点 Retry 后（pi 已恢复）菜单就地变成文件列表，**不重开工具窗、不弹任何对话框**
- [ ] 同样的失败态对 `/` 命令菜单独立成立（`@` 成功时 `/` 失败也会如实显示，互不影响）
- [ ] 项目里确实没有匹配文件时 → 显示「No matching files」且**没有** Retry 按钮（空 ≠ 失败）
- [ ] 新建一个文件后回到插件，打开 `@` 等 30 秒 → 新文件出现；或直接点菜单底部的 **↻ Refresh** → 立即出现
- [ ] 删除一个文件后点 **↻ Refresh** → 该文件从列表消失
- [ ] Manage → **Diagnostics** → 8 个数据源逐个列出状态徽标；失败项有原因摘要与 Retry，超长错误可展开 **Full error** 看全文（菜单里只显示截断后的摘要）
- [ ] 全部正常时 Diagnostics 顶部只有一行「All good」，**没有**红点、没有残留的旧错误
- [ ] 从没打开过的 Sessions 显示 **Not loaded**（而不是 Failed）；点其 Retry 或打开 Sessions 后变 Ready
- [ ] 桥接不支持的调用（如某版本没有 approval.getPolicy）显示 **Not supported**，且**不计入**失败、顶部不报红

## IDE 集成（v0.2 新增）

- [ ] 编辑器选中一段代码 → 右键菜单出现 **Pi Agent** 组（Explain / Fix / Send Selection to Pi）
- [ ] **Explain with Pi** → 工具窗激活，输入框预填了带 `file:line` 与选区代码的 prompt（可编辑后发送）
- [ ] **无选区时**右键 → 三个动作置灰
- [ ] **项目文件树右键任意文件 → Pi Agent → Send File to Pi Agent** → 整文件内容进输入框（v0.2.1）
- [ ] 同一菜单里 **Explain File with Pi** 在项目树中**也可点**（不再要求先打开编辑器）；选中目录/二进制/>256KB 文件时两项置灰，鼠标悬停能看到禁用原因
- [ ] 让 pi 改一个文件 → 改动工具卡片上点 **Diff** → 弹出 JetBrains 原生 Before/After 对比窗口（v0.2.1）
- [ ] 工具卡片/消息里的文件路径（绝对、相对、`~/` 均可）点击 → 编辑器打开对应行（v0.2.1）
- [ ] 状态栏出现 **π** widget：pi 运行中显示版本，崩溃显示 ⚠；点击 widget 打开工具窗
- [ ] 发一条让 pi 跑几十秒的任务，期间切到其他工具窗 → 任务完成时收到 **"Pi Agent finished"** 气泡通知，点击 **Show Pi Agent** 激活工具窗
- [ ] 同时打开两个项目窗口 → 两个工具窗各自独立对话，互不串扰（在 A 发消息，B 不出现任何事件）

## Sessions（会话）

- [ ] Sessions 页签列出本项目历史会话（名称/预览/时间/**消息数**）；顶部只有 filter 输入框（`+ New session` 已删除），窄窗下卡片右侧的复制/导出/删除与时间不被裁掉
- [ ] 点击某会话 → 回到 Chat 并回放历史消息
- [ ] 会话行 **⧉ Clone** → 新会话出现并被切换
- [ ] 会话行 **⇩ Export** → 弹出保存对话框 → 保存后收到"Pi session exported"气泡通知，HTML 可在浏览器打开（含完整消息，无脚本）
- [ ] 会话行 **✕ Delete** → 确认框 → 会话从列表消失；删除**当前**会话自动落到新会话
- [ ] Chat 工具栏 **Fork** → 以最后一条 user 消息为界分叉出新会话
- [ ] 重启 IDE 后打开工具窗 → 上一会话历史自动回放

## 设置（Settings → Tools → Pi Agent）

- [ ] 设置页出现 **Pi Agent**，含 pi 路径输入框（带 Browse）与自动打开复选框
- [ ] 填入 pi 路径 → Apply → 正在运行的 pi 自动重启，Manage 横幅显示新路径
- [ ] 勾选自动打开 → 新开项目窗口 → Pi Agent 工具窗自动激活
- [ ] 清空路径 → Apply → 恢复自动发现

## Commit Message 生成（VCS 集成）

前置：项目有 Git/Mercurial 等变更，打开提交面板（工具窗或模态对话框均可）。

- [ ] 勾选若干变更 → 提交面板出现 **Generate Commit Message with Pi**（灯泡图标，
      Alt+Shift+C），位于提交按钮旁下拉与消息框旁工具条
- [ ] 未勾选任何变更时按钮置灰
- [ ] 点击 → 后台进度条「Asking pi to write the commit message…」→ 完成后提交信息框
      自动填入 Conventional Commits 风格消息（首行 ≤72 字符），并出现成功气泡
- [ ] 生成过程中可取消 → 收到取消通知，信息框不变
- [ ] 生成的内容**不进入** Pi Agent 聊天会话（Chat 页看不到该请求与响应）
- [ ] 异常路径：清空设置里的 pi 路径并使其不可发现 → 点击生成 → 出现错误气泡
      （Failed to generate commit message: pi executable not found）
- [ ] 大 diff（>96KB）也能生成（diff 被截断后仍发送）

## Manage（管理）

- [ ] 顶部横幅显示 pi 版本与二进制路径（找不到 pi 时显示安装引导命令）
- [ ] **MCP Servers**：`pi mcp add demo -- echo hi` 后 Refresh 出现条目；Remove 可删除；有 OAuth 的服务器可 Login/Logout
- [ ] **MCP 停用（v0.5.1 新增）**：对一个已配置的服务器点开关 → 条目变虚线灰显、按钮显示 `Disabled`、副标题写 `configuration kept`；
  打开 `~/.pi/agent/mcp.json` 确认该条**只是多了 `"enabled": false`**，command / args / env 一字未改
- [ ] **MCP 停用 · 生效**：停用后重启 pi（或新开项目）→ `pi mcp list` 里该服务器不再连接、状态为 `disabled`；
  面板里它仍在列表中（可随时启用），不是消失了
- [x] **MCP 启用**：点回开关 → `mcp.json` 里 `enabled` 字段被删掉（不是写成 true），`pi mcp list` 里恢复连接，无需重填任何配置
- [x] **MCP 层级徽标**：用户级服务器显示 `user`，`.pi/mcp.json` 里的显示 `project`；
  若某服务器在本项目被覆盖，副标题出现 `overridden in this project`
- [ ] **MCP 需新会话**：对一个当前会话已连接的服务器点停用 → 出现一行提示「下个会话起生效，当前会话仍连着它」
- [ ] **MCP 写入失败**：手工把 `mcp.json` 改成非法 JSON 后点开关 → 横幅显示原始解析错误，开关**不翻转**，文件内容不变
- [ ] **Packages**：`pi install npm:@example/pi-tools` 后出现条目；Remove 可卸载
- [ ] **Skills**：用户级（`~/.pi/agent/skills`）与项目级（`.pi/skills`、`.agents/skills`）都列出，条目带「用户级 / 项目级」标签；项目未受信任时项目级条目显示「项目级 · 未生效」+ 虚线弱化 + 原因行；**+ New skill** 可创建模板
- [ ] **项目信任**：打开一个从未信任过的项目 → 面板顶部出现横幅，列出仓库里存在但会被 pi 忽略的 skills/MCP/settings/扩展；点「信任本项目」→ 二次确认逐项列出将生效内容 → 确认后横幅消失，保留一行状态 + 撤销入口
- [ ] **项目信任 · 生效验证**：信任后重启 pi（或重开项目）→ 项目级 skills 的「未生效」标记消失，且在 pi 里 `/skills` 能看到该 skill
- [ ] **项目信任 · 撤销**：点「撤销信任」→ 横幅回到未信任态，`~/.pi/agent/trust.json` 里该项目键被移除、**其他项目的键仍在**
- [ ] **项目信任 · 文件损坏**：手工把 `trust.json` 改成非法 JSON → 面板显示「无法读取信任配置」，只给「重试」**不给「信任」**（不能覆盖读不懂的文件）；恢复文件后重试即恢复
- [ ] **Auth**：列出已配置凭据/custom provider 的 provider；**Check** 显示 ready/not_ready
- [ ] **Settings**：加载 `~/.pi/agent/settings.json`；改坏 JSON 保存 → 报错不落盘；改合法 JSON 保存 → 成功且生成 .bak

## 异常路径

- [ ] 临时将 pi 移出 PATH（或 mock 崩溃 `MOCK_PI_FAIL=1`）→ 状态栏出现红色退出横幅与 stderr 摘要
- [ ] 项目关闭 → pi 进程终止（macOS/Linux：`ps aux | grep "mode rpc"`；Windows：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'mode rpc' }`）

## 自动化对应

以上 Chat/Sessions/Manage 的核心路径已由三层自动化覆盖：
`./gradlew test`（107 例，含 Commit Message 生成器的 diff 拼装/清洗、`PiTrust` 的路径归一化与原子写、`PiStartArgs` 的 `--approve` 单次消费、`PiMcpConfig` 的单键启停、`PiManage` 更新/Provider 反白名单、`PiMessageQueue` 的对齐与原子重排）· `cd web && npx playwright test`（115 例，其中 `layout.spec.ts` / `layout-regressions.spec.ts` 按几何值断言弹层/卡片/轴心/队列条，专门防 docs/UI_ISSUES.md 那类"DOM 在但看不见"的回归）· `bash scripts/e2e-ide.sh`（真实 JCEF 全链路）
