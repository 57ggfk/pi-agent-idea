# probe-036：pi-subagents RPC 线上取证（FR-011 前置）

- 日期：2026-11-28 · 本机 pi 1.6.1 + pi-subagents 0.89.2（settings `packages` 含 `npm:pi-subagents`）
- 脚本：`scripts/probe-036-subagents-rpc.mjs`；复现：`node scripts/probe-036-subagents-rpc.mjs [--observe-ms 30000]`
- 跑了 3 次（04:10 / 04:13 / 04:15），结果一致；每次 pi 以 exitCode=0 干净退出。

## 1. 权威启动方式（插件同款）

`PiStartArgs.build`（`src/main/kotlin/dev/pi/agent/process/PiProcessManager.kt:60-79`）：

```
--mode rpc  [+ --provider X --model Y]  [--extension <path> × N]  [+ --approve]
```

`PiLocator.spawnCommand`（`src/main/kotlin/dev/pi/agent/process/PiLocator.kt:202-209`）：
node script 时 `[node, piPath, ...args]`；Windows `.cmd` shim 外面再包 `cmd /c`。

探针用 `node <npm-global>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode rpc`
（`package.json` 的 `bin.pi` 指向同一入口，即 `where pi` shim 的目标；插件自带的三个
`--extension`（approval / model-reload / ide-env）与 subagents 面板无关，省略）。pi-subagents
经 settings `packages` 自动加载，不走 `--extension`。cwd 用临时目录（插件用 project.basePath）。

## 2. Framing（实测与文档一致）

`docs/json.md:13-19`：严格 JSONL，每条记录一个 JSON 对象，**只按 LF 切**、剥前导 CR；
U+2028/U+2029 在 JSON 字符串里合法、不是记录边界；禁用 Node readline；stdout 专用于 JSONL。
pi 侧实现 `dist/modes/rpc/jsonl.js` 同款。插件侧 `PiRpcClient.kt:119-160` 同款：
`type:"response"` 是命令响应（按 id 关联），其余每行都是事件。

## 3. 五个事件名 → 线上观察结果

| ping.events | 实际事件名（`pi-subagents/src/shared/types.js:8-20`） | 线上观察（空闲 30s） |
|---|---|---|
| `jobsChanged` | `subagent:jobs-changed` | **未观察到** |
| `asyncStarted` | `subagent:async-started` | **未观察到** |
| `childStatus` | `subagent:child-status` | **未观察到** |
| `asyncComplete` | `subagent:async-complete` | **未观察到** |
| `processTerminal` | `subagent:process-terminal` | **未观察到** |

静态证据解释了为什么：这五个都是 `pi.events.emit(...)` 的**进程内总线**事件
（`dist/core/event-bus.d.ts:1-4`；pi-subagents 文档自认 `extension-api.md:185`
"pi.events is in-process only. It does not reach separate Pi processes"）。
pi 的 RPC 模式只转发 `session.subscribe` 的会话事件（`dist/modes/rpc/rpc-mode.js:240-241`），
wire 分发对未知命令一律 `Unknown command`（`rpc-mode.js:579-581`），没有通用扩展事件通道。
**FR-011 的宿主事件订阅在 RPC 模式下落地为通道 A（setWidget 快照），见下。**

## 4. status 读数走哪条通道（实测）

wire 上发 `{"type":"status"}` / `{"type":"ping"}` → 均 `Unknown command: status/ping`。
pi-subagents 的 `status`/`ping` 是进程内事件总线 RPC（`extension-api.md:96-117`），不上线。
RPC 模式下宿主可用的四个通道（实测/源码佐证）：

- **通道 A：作业视图（事件驱动的 wire 等价物）** — `extension_ui_request(setWidget)`，
  `widgetKey:"subagent-async"`。空态实测：`{type,id,method:"setWidget",widgetKey:"subagent-async"}`
  （`widgetLines` 缺省 = 清除）。有作业时 `widgetLines:["PI_SUBAGENT_ASYNC_JSON:<快照JSON>"]`
  （`render.js:3129-3134` RPC 分支；`async-status-snapshot.js:4,24-26`）。
  会话启动时扩展就发一条空态 setWidget 注册 widget（3 次实测都有）。
- **通道 B：按需查证（无模型回合）** — 经 `{"type":"prompt","message":"/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]"}`
  （扩展命令经 prompt 立即执行，`docs/rpc-commands.md` prompt 节）。
  实测响应（no-such-run，error 变体）：
  ```json
  {"type":"extension_ui_request","id":"…","method":"setWidget","widgetKey":"subagent-inspect",
   "widgetLines":["PI_SUBAGENT_INSPECT_JSON:{\"kind\":\"pi-subagents.inspect-reply\",\"version\":1,
   \"requestId\":\"probe-inspect\",\"asyncId\":\"no-such-run\",
   \"error\":{\"code\":\"not_found\",\"message\":\"Async run 'no-such-run' was not found.\"}}"]}
  ```
  同一 handler 内先发后撤（两条 setWidget，`slash-commands.js:664-679`）。
- **通道 C：前台子代理进度** — 父会话 `subagent` 工具的 `tool_execution_update` /
  `tool_execution_end` 会话事件（`docs/json.md:106-107`），`details.progress[]` /
  `details.results[]`（`extension-api.md:143,155`）。
- **通道 D：transcript 重建（FR-011 降级路径）** — subagent 工具结果 `details.results[]`（前台）
  + `subagent-notify` 消息 `details.runs[]`（后台）（`extension-api.md:157`）。

setWidget 的 wire 形状（`rpc-mode.js:128-141`、`docs/rpc-extension-ui.md` setWidget 节）：
字段 `type / id / method / widgetKey / widgetLines / widgetPlacement`；
**`widgetLines` 只支持字符串数组**（组件工厂被忽略）；`widgetLines` 缺省或 undefined = 清除；
`widgetPlacement` 是 `"aboveEditor"`（默认）或 `"belowEditor"`。

## 5. async 快照 DTO（`pi-subagents/src/runs/shared/async-status-projection.d.ts:3-64`，源码面·非线测）

`PI_SUBAGENT_ASYNC_JSON:` 后是 `AsyncStatusSnapshot`：

- `kind:"pi-subagents.async-status-snapshot"`，`version:1`，`generatedAt`
- `caps:{maxRuns,maxChildrenPerNode,maxDepth,maxStringLength,maxSerializedBytes}`
- `omitted:{runs,children,byteLimitExceeded}`（越界信息）
- `runs[]:AsyncStatusSnapshotNode`：`id`、`kind`（`"subagent"|"workflow"|"step"|"host-step"`）、
  `label`、`state`（八值：`queued|running|complete|failed|partial|paused|stopped|rejected`，
  对应 FR-011 四态映射的素材）、可选 `startedAt/updatedAt/endedAt`、
  `activity?{state,currentTool,lastActivityAt,currentToolStartedAt,turnCount,toolCount}`、
  `progressText?`、`progressUpdatedAt?`、`agent?/model?/thinking?`（step 节点）、
  `hostStep?{kind,provider?,role?,state,verdict?,reasonCode?,detail?,target?,stale?,report?}`、
  `children?[]`（树形，chain/并行步骤流由此重建）

**快照是全量替换不是补丁**（`extension-api.md:386`：bounded progress snapshots, replace, don't merge）。

## 6. get_state / get_commands（实测）

`get_state` 的 `data` 一层字段：`model`（二层 `{id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,maxTokens,compat}`）、
`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`、`sessionFile`、`sessionId`、
`autoCompactionEnabled`、`messageCount`、`pendingMessageCount`。

`get_commands`：48 个命令，其中 subagent 相关 18 个：`subagents-watchdog, subagents, subagent-cost,
subagents-doctor, subagents-inspect-rpc, subagents-guide, subagents-refine, subagents-fleet,
subagents-detach, subagents-stop, subagents-steer, subagents-models, subagents-profiles,
subagents-load-profile, subagents-refresh-provider-models, subagents-generate-profiles,
subagents-check-profile, skill:pi-subagents`。

## 7. 合并建议（250ms）

`extension-api.md:151`：事件可爆发、可重复；宿主做合并——**每约 250ms 读一次刷新**，
in-flight 期间到达的刷新等读完后补一次。落到 FR-011 实现上：
订阅通道 A（setWidget `subagent-async`）+ 通道 C（tool_execution_update）触发标记 dirty，
250ms 节流重渲染；收到的新快照**整体替换**旧快照（第 5 节），不做增量合并。

## 8. Caveats（未确认点，如实记）

1. **五个 `subagent:*` 事件在有真实后台作业时是否出现在 stdout 未线测**（空闲会话无作业，
   本探针未触发真实模型调用）。静态证据（pi.events 进程内 + rpc-mode 无转发路径）预期**不会**上线；
   FR-011 按通道 A 实现，若后续真机发现事件也上线则作为补充。
2. 通道 A **有作业时**的 widgetLines 快照实例、通道 B **成功变体**（含 status/details/messages）、
   `details.progress[]` / `details.results[]` / `details.runs[]` 的**完整字段清单**——都需要真实
   子代理作业（模型调用），本探针没有触发（避免烧 API 配额）。字段结构以第 5 节 .d.ts 为准。
3. 探针以 `node` 直连 cli.js，等价于 PiLocator 的 node-script 分支；未走 `where pi` 的 `.cmd` shim
   路径（同一入口脚本）。cwd 是临时目录，非项目 basePath。
4. 插件启动参数中的 `--extension`×3（approval / model-reload / ide-env）未带——对 subagents 面板
   无影响的插件自有扩展。
5. 每次探针在 `~/.pi/agent/sessions/` 留一个新会话文件（pi 正常行为，与插件每次开会话一致）。
