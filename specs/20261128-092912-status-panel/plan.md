# 技术方案：状态面板——运行状态 / 后台任务 / 处理清单 / 待处理 / 产出

**Branch**: `feat/status-panel` | **Date**: 2026-11-28 | **Spec**: [spec.md](./spec.md) · **探针**: [probe.md](./probe.md)
**Input**: Feature specification from `/specs/20261128-092912-status-panel/spec.md` · GitHub Issue [#15](https://github.com/57ggfk/pi-agent-idea/issues/15)

## Summary

五个分区（运行状态 / 后台任务 / 处理清单 / 待处理 / 产出）全部由**既有数据源**驱动，v1 零新增 Kotlin 桥接：
运行状态与 StatusBar 同源（store 既有字段）；待处理消费既有 `approvals`；后台任务走探针锁定的通道 A
（`setWidget(subagent-async)` 快照）；处理清单与产出从 transcript（store `items`）纯函数推导。
UI = chat tab 栏「状态」tab-tool-btn + 大纲同款限宽弹层（top 40px / right 8px，`min(320px, 100cqw-24px)`），
与大纲/搜索互斥。面板只读 + 跳转，不复制任何操作入口。

## Technical Context

- **Language/Version**：TypeScript + React + Vite（`web/`）；宿主 Kotlin 本 spec **预期零改动**（如实现中发现必须动 Kotlin → escalate，见 tasks.md 头注）。
- **Primary Dependencies**：zustand（store）、vitest（单测）、Playwright（e2e）、Icon 内联描线 sprite。
- **Storage**：N/A——全部内存态；产出/清单随 `items` 生命周期（会话切换天然重算，FR-007 靠构造成立）。
- **Testing**：`cd web && npm test`（vitest）+ `cd web && npx playwright test`；门禁由脚本跑，本 plan 只约定断言清单。
- **Target Platform**：JCEF 工具窗内 webview；窄面板判据 360px（FR-010）。
- **Project Type**：IDE 插件前端功能（web-only）。
- **Performance Goals**：打开面板三秒内可读（US1）；后台快照 250ms 节流合并（FR-011，`extension-api.md:151`）。
- **Constraints**：弹层限宽 `min(320px, 100cqw - 24px)`；断言必须含几何与行为（宪法 II）；无 `overflow: hidden` 掩盖溢出（宪法 III）。
- **Scale/Scope**：1 个弹层组件 + 5 分区 + 4 个纯函数数据模块 + mock 场景 + 1 个 e2e spec；触及文件集中在 `web/src/store/`、`web/src/lib/`、`web/src/components/`、`web/src/bridge/mock.ts`、`web/e2e/`。

## Constitution Check

| 门 | 判定 |
|---|---|
| I 双端契约同步 | 本 spec 无新跨端字段：消费的 `extension_ui_request`（setStatus/setWidget）真源在 pi 的 `rpc-mode.js:92-115/128-141`，web 侧类型落 `web/src/store/types.ts`，无 Kotlin 数据类改动 → 不触发 |
| II 断言含几何与行为 | FR-010 明确要求；e2e 任务（tasks T8）逐条列几何断言，`toBeVisible()` 不作为溢出/锚点的证据 |
| III 布局不靠环境假设 | 弹层宽度用 `min(320px, 100cqw - 24px)`（容器查询单位，同 `.session-outline` `styles.css:5167`），不按滚动条像素推算 |
| IV pi 生态写操作可回滚 | 面板全只读（FR-008），不写 `~/.pi/agent/` → 不触发 |
| V JCEF 单向 | 全部数据走既有 pi RPC 事件流（pi → web 方向）与既有 `ide.showFileDiff` / `ide.openFile` 桥方法 → 不触发 |
| VI 凭据零托管 | 不涉及 |

无违宪项，Complexity Tracking 留空。

## 探针结论（FR-011 数据通道锁定；probe.md 已在本机核实，出处逐条可查）

1. **`status` 不是 wire 命令**：wire 上发 `{type:"status"}` / `{type:"ping"}` → 均 `Unknown command`
   （`rpc-mode.js:579-581`，实测 probe.md §3/§4）。pi-subagents 的 `status`/`ping` 是进程内事件总线 RPC
   （`extension-api.md:96-117`），不上线。
2. **五个 `subagent:*` 事件预期不上线**：它们是 `pi.events.emit(...)` 进程内总线事件
   （`extension-api.md:185` 自认 "in-process only"），RPC 模式只转发 `session.subscribe` 的会话事件
   （`rpc-mode.js:240-241`），无通用扩展事件通道。FR-011 **按通道 A 实现**，若真机发现事件也上线则作补充（tasks T9.3）。
3. **通道 A（作业视图真身）** = `extension_ui_request` `method:"setWidget"` `widgetKey:"subagent-async"`：
   - wire 形状 `{type,id,method,widgetKey,widgetLines,widgetPlacement}`，`widgetLines` 仅字符串数组，
     **缺省 = 清除**（`rpc-mode.js:128-141`）；`widgetPlacement` 仅 `"aboveEditor"`（默认）/`"belowEditor"`。
   - 有作业时 `widgetLines:["PI_SUBAGENT_ASYNC_JSON:<快照JSON>"]`（`render.js:3129-3134` RPC 分支；
     前缀常量 `async-status-snapshot.js:4`）。
   - 空态（无作业）时扩展发**不带 widgetLines 的 setWidget** 注册 widget——会话启动即发（probe.md §4，
     3 次实测都有）。**这就是「扩展已装」的注册信号**（分区可见性用）。
   - 前缀后是 `AsyncStatusSnapshot`（`async-status-projection.d.ts:3-64`，**源码面·非线测**）：
     `kind:"pi-subagents.async-status-snapshot"`、`version:1`、`generatedAt`、
     `caps{maxRuns,maxChildrenPerNode,maxDepth,maxStringLength,maxSerializedBytes}`、
     `omitted{runs,children,byteLimitExceeded}`、
     `runs[]` 节点 `{id, kind:"subagent"|"workflow"|"step"|"host-step", label,
     state(八值 queued|running|complete|failed|partial|paused|stopped|rejected),
     startedAt?,updatedAt?,endedAt?, activity?{state,currentTool,lastActivityAt,currentToolStartedAt,turnCount,toolCount},
     progressText?,progressUpdatedAt?, agent?,model?,thinking?, hostStep?{kind,provider?,role?,state,verdict?,reasonCode?,detail?,target?,stale?,report?},
     children?[]}`。
   - **快照是全量替换不是补丁**（`extension-api.md:386`）；合并建议 250ms 节流 + in-flight 保留
     （`extension-api.md:151`，probe.md §7）。
4. **通道 B（按需查证）**：`/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]` 经 prompt
   执行，回 `setWidget(subagent-inspect)` 包 `PI_SUBAGENT_INSPECT_JSON:`（error 变体实测 probe.md §4）。
   **v1 不用**——面板是被动视图，不做主动查询入口。
5. **通道 C（前台子代理进度）**：随父会话 `subagent` 工具卡的 `tool_execution_update` `details.progress[]` /
   `details.results[]`（`extension-api.md:143,155`；results 行含数值 `index`，run 内唯一、跨部分快照与最终
   结果稳定，宿主按 `(runId,index)` 关联）。**v1 面板不消费**——FR-011 原文即「前台子代理进度随父会话工具卡」，
   工具卡（ToolCard）是它的展示位；面板不重复建前台视图。
6. **通道 D（transcript 重建，FR-011 降级/重载路径）**：`subagent` 工具结果 `details.results[]`（前台）+
   `subagent-notify` 消息 `details.runs[]`（后台，`extension-api.md:157,666`；entry 带 `agent`、
   `status: completed|failed|paused|stopped`）。`get_messages` 回放路径可取（store.ts:1759,2252,2630）。
7. **get_state 一层字段（实测 probe.md §6）**：`model{id,name,api,provider,baseUrl,reasoning,input,cost,
   contextWindow,maxTokens,compat}`、`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、
   `followUpMode`、`sessionFile`、`sessionId`、`autoCompactionEnabled`、`messageCount`、`pendingMessageCount`。
   ——FR-002 全部字段 store 已有（`get_state` 已存 `model`；上下文/成本走既有 `get_session_stats`），
   **不需要新增任何读取**。
8. **`get_commands`**：48 命令中 18 个 subagent 相关（probe.md §6）——仅供 mock/诊断参考，面板不消费。

### 与 spec 的偏差声明（FR-011 数据机制）

spec.md:127-131 的 FR-011 原文写「订阅宿主事件（jobsChanged / asyncStarted / childStatus /
asyncComplete / processTerminal）触发读 status」——探针证明该机制在 RPC wire 上不成立（五事件是
进程内总线事件、RPC 模式只转发 `session.subscribe` 会话事件，本节第 2 条 + probe.md §3/§4）。
实现按通道 A（setWidget 快照）改道，这是**有证据的有意偏差**，不是遗漏：/speckit.analyze 会报
spec/plan 失配，处置 = 回填 spec.md 该句（tasks T9.6，probe.md §3/§4 作佐证）；本 plan 不等回填、
按通道 A 实施。

### 未线测清单（实现时按此标注，不冒充已验证）

- 通道 A **有作业时**的快照实例；通道 B 成功变体；`details.progress[]` / `results[]` / `runs[]` 完整字段
  ——都需要真实子代理作业（烧 API 配额，probe 未触发）。**字段结构以 `async-status-projection.d.ts` 为准**。
- `get_messages` 是否回吐 `role:"custom"`（`display:false` 的 subagent-notify）与 `toolResult` 的 `details`
  ——通道 D 的可行性前提（pi `CustomMessage` 形状：`messages.d.ts:34-42`）。
- 五事件在真实后台作业下是否出现在 stdout（静态证据预期否）。

## 数据层（web/src/store + web/src/lib，全部纯函数优先、vitest 可测）

### D1 setStatus 条目（FR-003）

现状：`handlePiEvent` 的 `extension_ui_request` 分支里，`approvalFromEvent` 对非对话框方法返回 null →
setStatus/notify/setWidget 全部被丢弃（`types.ts:204-221` 的 `DIALOG_METHODS` 只认 confirm/select/input/editor；
丢弃点 `store.ts:1329-1336`）。

- wire 形状：`{type:"extension_ui_request", id, method:"setStatus", statusKey, statusText}`（`rpc-mode.js:106-115`）。
  扩展侧签名 `setStatus(key, text: string | undefined)`（`core/extensions/types.d.ts:100`）——**`statusText`
  缺失/undefined = 清除该条目**（JSON 序列化会丢 undefined 键）。
- store 新增：`extensionStatuses: Array<{ statusKey: string; text: string; updatedAt: number }>`，
  按 statusKey upsert（插入序稳定，同 key 覆盖不换位）；`statusText` 非 string → 按 key 删除。
  **cap 12 条**（越界按 updatedAt 最旧逐出，防御刷屏扩展；D-推荐值）。
- **清空规则**（条目属于产生它的 pi 进程）：`piStatus` 离开 `running`（exited / 重新 starting）时整体清空
  ——进程死了/换新进程，旧条目必属旧进程，镜像留着就是残留；**插件侧会话切换不清**（同进程内的
  switch_session 不产生新条目来源，条目是否变化由扩展自己的 setStatus 决定，面板只镜像）。
- `setWidget` / `notify` 本期仍丢弃（D-4）——**唯一例外**是 `widgetKey==="subagent-async"` 的 setWidget，
  它是 FR-011 的数据通道（见 D2），在 reducer 里先截获；FR-003 的「丢弃」指不做通用展示，两者不矛盾。
- 类型进 `web/src/store/types.ts`（双端契约真源），单测覆盖 upsert / 清除 / cap / 与 approvals 分支互不干扰。

### D2 后台作业 reducer（FR-011，通道 A 为主）

- store 新增：`subagentAsync: { seen: boolean; snapshot: AsyncStatusSnapshot | null; updatedAt: number }`。
  - `seen=true` 在收到**任意** `setWidget(subagent-async)`（含空态注册帧）时置位 → 后台任务分区的
    「扩展已装」信号；`snapshot===null` 且 `seen` → 已装但无作业（分区显示空态文案，D-推荐值；
    从未 `seen` → 未装 → 分区隐藏，US5-3）。
  - `widgetLines` 缺省 → `snapshot=null`（清除语义，probe.md §4）；`widgetLines[0]` 带
    `PI_SUBAGENT_ASYNC_JSON:` 前缀 → 剥前缀、`JSON.parse`，校验 `kind==="pi-subagents.async-status-snapshot"`
    且 `version===1`，任一不符 → 整帧丢弃（防御，不崩）。
  - **整体替换**：新快照覆盖旧快照，不做字段级合并（`extension-api.md:386`）。
- **250ms 节流**：解析同步廉价，用「尾随定时器」实现——事件到 → dirty 标记 + 定时器未 armed 则 arm 250ms；
  fire 时把最新快照落 store。in-flight 期间到达的刷新自然并入下一次 flush（满足 `extension-api.md:151`
  「读完后补一次」）。定时器放 store 闭包外模块级（同 `noticeTimer` 惯例 `store.ts:802-807`），store reset
  不复活旧定时器。
- **会话切换重置（FR-011 F-24 之戒：状态不得残留过期）**：`runNewSession` 与 `switchSession` 的两个既有
  重置点（`store.ts:947-959` 的 `resetConversationLocalState`、`store.ts:2210-2212` 的 switchSession 乐观 set
  ——两处都只清 outline/search/queue）都要加：`subagentAsync.snapshot = null`（旧会话的作业快照不得残留到
  新会话），**`seen` 保留**（「扩展已装」是机器级事实，不随会话；新会话若扩展重新注册，快照随帧恢复——
  是否重发注册帧未线测，T9.1 顺带核验）。
- **八值 state → FR-011 四态映射（D-推荐值，真机 T9.1 复核）**：

  | AsyncStatusSnapshotState | 面板四态 | 理由 |
  |---|---|---|
  | `running`、`queued` | 运行中 | OSC 7501 语义 running；排队也是「在跑」 |
  | `paused` | 等待你 | 作业挂起等用户输入 |
  | `complete` | 已完成 | — |
  | `failed`、`partial`、`stopped`、`rejected` | 失败 | 有未消化失败 / 人停 / 被拒，都归失败组；`partial` 用「部分失败」文案区分 |

  未知 state 值**不强行归组**，原样小写展示（映射表断言里写死这一行为）。
  **缺失/违约态**：节点 `state` 缺失或非字符串（wire 运行时违约——`.d.ts` 只约束类型面，JSON 面无校验）
  与 `activity.state`（`async-status-projection.d.ts:8` 本就可选）同样按「未知」中性徽标处理，不归四态。
- **chain 步骤流**：`runs[]` 节点的 `children[]` 树重建步骤序列（`label` + 节点 state），渲染
  `✓ scout → ● worker → ○ reviewer` 式一行；workflow/step/host-step 节点同规则递归（深度 cap = snapshot
  `caps.maxDepth`，截断时用 `omitted.children` 提示）。
- 类型 `AsyncStatusSnapshot`（只取面板消费的字段子集）进 `web/src/store/types.ts`，注明源码面出处。

### D3 transcript 重建（FR-011 通道 D）

- `itemsFromMessages`（`types.ts:631-678`）目前跳过 `role!=="user"|"assistant"`（toolResult 单独处理）。
  扩展：捕获 `role:"custom" && customType==="subagent-notify"` 的 `details.runs[]`（后台历史行）与
  `role:"toolResult"` 且 `toolName==="subagent"` 的 `details.results[]`（前台历史行，按 `(runId,index)`
  关联去重），落 store 的 `subagentHistory`（随 items 重放刷新）。
- **真机前提未核验**（见「未线测清单」第 2 条）：`get_messages` 是否回吐这两类 details。T9.2 核验；若不回吐，
  降级方案 = 重载后历史行仅由通道 A 快照承担（subagent-async 快照内 state 为 complete/failed 的 runs 本身
  就是「刚跑完的作业」），通道 D 任务标记降级并在 tasks 里注明。

### D4 todo 快照解析（FR-012）

- **本机未装 todo 类扩展，无权威 schema 可读**——这是与产出推导（D6）的本质区别，plan 明确标注：
  解析器是**容错兼容层**，工具名清单与字段形状以真机遇到为准扩展，断言用 mock 自定形状（mock-only，注明）。
- `TODO_TOOL_NAMES` 白名单常量（v1 候选：`todo_write` / `todo-update` / `todowrite` / `todo`，命中即可）；
  从 `items` 的 toolcall 块（`done===true`，流式未完块跳过）取**最近一次**快照，整体替换。
- argsJson 容错：数组字段依次试 `items` / `todos` / `list`；条目文本依次试 `text` / `content` / `label` /
  `title`；条目状态依次试 `state` / `status` / `done`（boolean → done?✓:○），归一为
  `pending | active | done | cancelled` 四值（FR-012 三态 + ⊗ 已取消备用）。
- 无快照 → 分区隐藏（FR-012）。pi-subagents chain 步骤态作为该分区补充来源——**v1 不做**（D-推荐值）：
  chain 步骤流已在后台任务行内展示（D2），重复展示增加维护面。

### D5 产出推导（FR-006 / FR-007）——工具名清单与 argsJson 权威 schema

- **工具名清单（权威出处）**：pi core 工具全集 `ToolName = "read"|"bash"|"powershell"|"edit"|"write"|
  "grep"|"find"|"ls"`（pi 本地包 `dist/core/tools/index.d.ts:23`）。写类 v1 = **`write`、`edit` 两个**：
  `read/grep/find/ls` 只读；`bash/powershell` 不算——spec 边界明说「bash 里改文件看不到」。
  清单写成常量 `WRITE_TOOLS = ["write", "edit"] as const`，注明出处与扩展规则（未来装了别的写类扩展在此追加）。
- **argsJson 权威 schema**（读 pi 本地包，非 mock 形状）：
  - `write`：`{path: string, content: string}`（`dist/core/tools/write.d.ts:4-7`）。
  - `edit`：`{path: string, edits: [{oldText: string, newText: string}]}`（`dist/core/tools/edit.d.ts:5-11`）。
  - 路径字段两工具同名同义，都是 **`path`**。容错回退 `file_path` / `filePath`（个别生态工具的 Claude 风格
    形状；只作解析兜底，mock 与断言的主路径只用权威 `path`）。
- 推导规则：遍历 `items` 的 toolcall 块（`done===true`）→ `JSON.parse(argsJson)`（失败跳过）→ 命中
  `WRITE_TOOLS` → 取路径。**按路径去重**，每路径记录：改动类型集合（write→「新建/重写」、edit→「编辑」）、
  调用次数、最近一次的 item id（排序/去重键）。展示名走既有 `web/src/lib/shortPath.ts`。
- **会话隔离（FR-007）靠构造成立**：推导是 `items` 的纯函数（`useMemo`），`runNewSession` 清空 items
  （store.ts:986-997）、`switchSession` 重放重建（store.ts:2272）——切会话天然重算，无跨会话累计。
- 点击行为（FR-006）：调用 `ide.showFileDiff`，**不可 diff 时退 `ide.openFile`**。现状 `showFileDiff`
  吞错返回 void（store.ts:2880-2886），面板拿不到成败 → 新增 store 动作 `openOutput(path)`：
  先试 `showFileDiff`（改造为返回 ok 布尔），失败/拒绝再试 `openFile`（store.ts:2865 已有，返回布尔）。
  仅 web 改动，桥方法（`bridge/types.ts:41,43`）已存在。
- 文案语义红线（spec 边界）：这是「pi 的写操作清单」，不冒充 git status——bash 改的文件不出现。

### D6 待处理区（FR-004）

- 数据现成：`approvals: PendingApproval[]`（`types.ts:183-195`，含 `method` 四类 → US2-4 类型可区分），
  事件侧 `store.ts:1329-1336` 已入列；作答后移除（`respondApproval`）、`agent_settled` 清空
  （store.ts:1283-1288）→ 计数归零（US2-3）靠构造成立。
- 边界（读码事实）：ApprovalCard 只渲染 `approvals[0]`（`ApprovalCard.tsx:28`，pi 一次只问一题）。
  面板条目点击 = `setTab("chat")` + 对队头卡 `scrollIntoView` + 闪烁高亮；**非队头条目没有对应卡**
  （pi 还没问到它），点击同样只切 tab——组件注释写明，e2e 只对队头条目断言定位。
- 分区可见性：`approvals.length===0` → 隐藏（无待处理是常态，不占视觉位；D-推荐值）。

### D7 运行状态区数据（FR-002）

与 StatusBar 完全同源（同一 store 字段，FR-002 硬性要求）：

| 展示 | store 字段 | 出处 |
|---|---|---|
| 运行态 | `piStatus` 四态 + `isStreaming` 合成：running+streaming→生成中；running+!streaming→空闲；starting→启动中；exited→已退出（附「到 StatusBar 重启」指引文案，不复制按钮）；notStarted→未启动 | store.ts:391, StatusBar.tsx:89 |
| 当前模型 | `model?.name ?? model?.id` | store `model`（get_state 已存） |
| 上下文占用 | `stats?.contextUsage.percent` / `tokens` | store.ts:2674-2681（`get_session_stats`） |
| 成本 | `stats?.cost` | 同上 |
| 扩展状态条目 | `extensionStatuses`（D1） | setStatus 事件 |

`piStatus==="exited"` 的重启入口指引是**跳转提示文案**（指去 StatusBar），面板不放重启按钮（FR-008）。

## UI 层

### U1 入口与弹层（FR-001）

- `App.tsx` tab-tools（store.ts 对应渲染块 App.tsx:139-181）加第三个 tab-tool-btn：`data-testid=
  "status-panel-btn"`，图标复用既有 `gauge`（`Icon.tsx` IconName 已含），**无角标**（D-1 拍板）。
  不像 outline 按钮那样按 `userCount>0` 条件隐藏——状态按钮恒显（空会话也要能看运行状态）。
- `StatusPanel.tsx` 新组件：锚点/限宽**整套**复用 `.session-outline` 的定位公式（`styles.css:5162-5176`）——
  `position:absolute; top:40px; right:8px; width:min(320px, calc(100cqw - 24px))`，
  **`max-height:min(60vh, 420px)`（styles.css:5167）+ 分区主体内部滚动**（`.outline-list` 的
  `overflow-y:auto` 同款，styles.css:5202）。`.app` 只有 `overflow-x: clip`（styles.css:252），纵向不裁剪
  ——五分区 + cap 12 条 extensionStatuses + 作业列表叠起来，矮 JCEF 工具窗里弹层会被窗底硬裁，
  所以限高内滚不是装饰是硬要求。z-index 与 outline 同档（55）。头部 = 标题 + 关闭钮（同 outline-head
  形制）；主体五个分区纵排。
- 组件从 store 单向取数；所有分区渲染交给 store 状态 + 纯函数（D1-D7），组件内不再二次推导。

### U2 三弹层互斥（FR-001）

- **读码事实**：今天 outline 与 search **彼此并无互斥**——`toggleOutline`（store.ts:1511-1513）不关
  search，`openSearch`（store.ts:1515-1517）不关 outline；两者可同时 open（视觉上同为 absolute 弹层）。
  spec 说「复用现有互斥逻辑」是把现状想当然——**本次在 store 补齐**：`statusPanelOpen` + `toggleStatusPanel`，
  打开状态面板时关 outline 与 search；`toggleOutline`/`openSearch` 打开时关状态面板。
- **范围红线**：只建立「状态面板 ↔ outline / search」的互斥；outline ↔ search 的既有共存行为**不动**
  （spec FR-001 只要求状态面板与两者互斥，顺手互锁 outline/search 属范围蔓延）。
- 会话切换/新建时状态面板不强制关闭（运行状态、后台作业跨会话仍有意义）；outline/search 的既有重置
  **有两处**——`resetConversationLocalState`（store.ts:947-959）与 switchSession 的乐观 set
  （store.ts:2210-2212，含 `outlineOpen:false` 与 search 重置）——两处都保持「不关状态面板」，
  并同时落 D2 的快照重置（清 snapshot 留 seen）。

### U3 分区渲染与隐藏/空态规则

| 分区 | 显示条件 | 空态 |
|---|---|---|
| 运行状态 | 恒显 | 无（四态运行态兜底一切） |
| 后台任务 | `subagentAsync.seen`（通道 A 注册信号，probe.md §4） | seen 且无作业 → 空态文案「暂无后台任务」；未 seen → 整区隐藏（US5-3） |
| 处理清单 | 有 todo 快照（D4） | 无快照 → 整区隐藏（FR-012） |
| 待处理 | `approvals.length > 0` | 零 → 整区隐藏（D-推荐值） |
| 产出 | 恒显 | 无写操作 → 明确空态文案（US4-4 specked，不隐藏、不是空白） |

- 处理清单条目：`done→✓`、`active→◌ 置顶高亮`、`pending→○`、`cancelled→⊗`（备用态）；
  排序 = active 最前，其余保持快照序（US3-1）。
- 后台任务条目：作业名 + 四态徽标 + chain 步骤流一行（D2）；前台子代理进度不在此区（D 层结论 5）。
- 待处理条目：标题摘要 + method 徽标（confirm/select/input/editor，US2-4），可点击（D6）。
- 产出条目：shortPath + 改动类型徽标（新建/重写、编辑；双类型并存时并排两徽标）+ 次数；可点击（D5）。

### U4 i18n（FR-009）

- 键 namespace `panel.*`，`web/src/i18n/locales/{en,zh}.ts` 同步补齐（分区标题、四态徽标、改动类型、
  空态文案、重启指引、方法徽标等）；`i18n.test.ts` 加「panel.* 必需键在 en/zh **存在**」断言（先红）
  ——不能写「键集合一致」：既有 `zh covers every key of en`（i18n.test.ts:22-27）已覆盖奇偶，
  panel.* 两侧同缺时一致断言恒绿，永远红不了。
- 大写/译法循仓库 memory 规约（竞品证据），分区名以用户原话为基准（spec 边界）。

### U5 mock 场景（e2e 数据源，全部 mock.ts 内 query knob 驱动）

- **默认 run 的 edit 必须算进产出期望**：mock 的 scripted run 每次无条件先发一条默认 edit
  （`path:"src/main.tsx"`、mock 自造形状 `old_string/new_string`，mock.ts:2597-2601）。产出推导只看
  toolName+path（D5），这条默认 edit 照常进推导——panel 场景的双 edit 打**独立路径**避让：
  期望产出 = 3 个路径、其一 ×2，正好对齐 spec US4-1「3 个文件（其一改了两次）」
  （默认 edit→src/main.tsx「编辑」×1；panel write→src/feature.ts「新建/重写」；
  panel edit→src/lib/util.ts「编辑」×2）。mock 自造形状与权威形状的「并存」只对 ToolCard diff
  测试成立；对产出推导二者同权，无隔离。
- `?panel=1`：一次 scripted run 内追加——write（权威形状 `{path:"src/feature.ts",content:…}`）+
  edit×2（权威形状 `{path:"src/lib/util.ts",edits:[{oldText,newText}]}`，同文件调两次测去重）+
  setStatus 出现→清除两帧 + `setWidget(subagent-async)` 三帧（空态注册 / chain 2/3 运行中快照 /
  complete 快照，**帧间隔 ≥250ms（400ms）**——每帧独立落 store，UI 才能断言「运行中→已完成」与
  chain 步骤流文本；spec US5-1 的「步骤 2/3」必须能出现在 UI 上）+ 一条 confirm 审批挂起（复用
  既有 `?approval=1` 门）。
- `?panel=todo`：追加一次 todo 类工具调用快照（mock 自定形状 `{todos:[{label,state}]}`，注明 mock-only）。
- **mock 补桩（FR-006 回退路径的可观测性）**：`ide.showFileDiff` handler 现状只裸 resolve
  （mock.ts:882-884，无回显、无失败 knob）→ 补 sessionStorage 回显（`pi-mock-show-file-diff`，
  同 `ide.openFile` 的回显模式 mock.ts:862-870）+ `?showFileDiff=fail` knob；`ide.openFile` 已有回显与
  `?openFile=fail`，不动。US1-3 的「已退出」用既有 `?pistate=exited` knob（mock.ts:406、2815-2837），
  无需新桩。
- 默认 mock（无 knob）不带任何 subagent-async 帧 → 后台任务分区隐藏断言直接用默认场景。
- 节流的「爆发只落最后一帧」**不在 e2e 测**——e2e 走真实时钟，<250ms 爆发帧只会让前两帧对用户不可见
  （与 T8.1 的「运行中→已完成」断言直接矛盾）；该行为由 T3.5 fake-timers 单测覆盖。

### U6 e2e 断言（FR-010 + 宪法 II；文件 `web/e2e/status-panel.spec.ts`）

- **几何（横向）**：360px 视口下 `document.documentElement` 无横向溢出（`scrollWidth<=clientWidth`）；弹层
  right 边距 8px / top 40px（boundingBox 断言）；宽度 ≤ `min(320px, 100cqw-24px)` 换算值且右缘不出视口。
- **几何（纵向）**：矮视口（如 480×600）下弹层底缘 ≤ 视口底（max-height 生效），超高内容在弹层**内部**
  滚动且不把窗撑出纵向滚动——`.app` 纵向不裁剪（styles.css:252 只有 `overflow-x: clip`），横向判据过了
  挡不住窗底硬裁。
- **US1 四场景（P1 地基，spec.md:49-53）**：空闲 + 模型名 + 上下文占用（`?panel=1` 空闲期断言）；
  流式期间 2s 内变「生成中」（mock 流式 chunk 间隔 40ms，天然满足）；`?pistate=exited` 显示「已退出」+
  重启指引文案且**面板内无重启按钮**（FR-008）；setStatus 条目出现、清除后消失。
- **US2 计数与类型（spec.md:60/64）**：`?approval=1` 显示「1 个待处理」；`?dialog=select|input|editor`
  （既有 knob）类型徽标可区分；作答后计数归零。
- **互斥**：开状态面板 → 开大纲 → 状态面板关（反之亦然）；开搜索 → 状态面板关；会话切换后状态面板
  仍开（U2 决策）且旧作业快照已清（D2 重置规则）。
- **行为**：待处理条目点击 → 切回 chat tab + 队头卡在视口内；产出条目点击 → sessionStorage
  `pi-mock-show-file-diff` 回显命中路径；`?showFileDiff=fail` 时回退 `ide.openFile`（sessionStorage
  `pi-mock-open-file` 回显）；切会话后产出区重算。
- **分区规则**：默认场景后台任务/处理清单隐藏、产出空态文案；`?panel=1` 后台任务三帧依次呈现
  （运行中→已完成）、chain 步骤流文本、四态徽标；`?panel=todo` 三态图形与 active 置顶。
- **i18n**：切 zh 后分区标题为中文（验收时切语言检查，FR-009）。

## Project Structure

```text
web/src/
├── components/
│   ├── StatusPanel.tsx          # 弹层 + 五分区（新）
│   └── StatusPanel.test.tsx     # 组件级单测（运行态合成 / US1 四场景 / 待处理计数与徽标 / 分区规则 / 四态徽标 / 空态）
├── lib/
│   ├── subagentSnapshot.ts      # 前缀剥离/校验/四态映射/chain 步骤流重建（新）
│   ├── subagentSnapshot.test.ts
│   ├── todoSnapshot.ts          # FR-012 容错解析（新）
│   ├── todoSnapshot.test.ts
│   ├── outputDerivation.ts      # FR-006 产出推导（新）
│   └── outputDerivation.test.ts
├── store/
│   ├── types.ts                 # AsyncStatusSnapshot 子集 + ExtensionStatus 类型（改）
│   ├── store.ts                 # setStatus/setWidget 截获 + 节流 + openOutput + 互斥 + goToApproval（改）
│   └── store.statuspanel.test.ts
├── bridge/
│   └── mock.ts                  # ?panel=1 / ?panel=todo 场景（改）
└── i18n/locales/{en,zh}.ts      # panel.* 键（改）

web/e2e/status-panel.spec.ts     # 几何 + 互斥 + 五分区行为（新）
changelog.d/20261128-status-panel.added.md
```

不新增 Kotlin 文件；`src/` 预期零 diff。

## 复杂度取舍（Complexity Tracking）

无违宪项。唯一值得记录的取舍：spec 写「复用现有互斥逻辑」而现状并无互斥（U2 读码事实）——方案选择在
store 补三弹层互斥而非引入通用 popover 管理器（三个弹层、两组关系，一个 store 布尔字段是更小的机器）。

## Phase 计划（对应 tasks.md）

1. **T1 探针核验**（先行门禁）：复核 probe.md 引用与通道锁定，不重跑烧配额探针。
2. **T2-T7 数据层**：每个模块先红测试后实现——setStatus（D1）、后台作业（D2）、transcript 重建（D3）、
   todo（D4）、产出（D5）、待处理跳转（D6）；D7 无新代码，不设任务。
3. **T8 UI 层**：e2e 断言先行（红）→ 互斥/按钮/弹层 → 分区组件 → mock 场景 → i18n → changelog 碎片。
4. **T9 真机验收**：烧配额项（真实后台作业）单列由人决定时机；不烧项（i18n/窄面板/会话切换）常规跑。
