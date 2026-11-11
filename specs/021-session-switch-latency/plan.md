# Implementation Plan: 021 会话切换与新建的响应延迟

**Branch**: `release/0.5.7` | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)
**Tasks**: [tasks.md](./tasks.md)（A 轨新建 / B 轨历史切换 / C 轨列表索引 / D 轨度量与收尾）

## 摘要

症状是「点完等 1s 多」，但代码里没有任何一处 `sleep`、也没有慢轮询：`BridgeTransport.pollAfter` 用 `Condition` 精确唤醒，`handleEnvelope` 是每信封一个协程、不排队。1s 的来源是**四段等待被串起来**：

```
点击 ──[1] await RPC（界面零反馈）──[2] 改 view（等 RPC 回来才改）──
     ──[3] 再 await 一轮独立 RPC（内容才出来）──[4] 屏幕还是旧帧（OSR 未重绘）
```

修法不是「让 RPC 变快」，而是**把界面反馈从 RPC 上摘下来**，并顺手砍掉两处真实成本：切换路径上三个互相独立的 RPC 串行执行、`new_session` 之后同步等待整个会话树重扫。

Kotlin 侧唯一改动是会话索引（`PiSessionIndex`）：现在为**所有项目**的每个会话文件最多解析 4000 行 JSON，而只需要第一个头行就能判断归属。

## 技术上下文

- **语言/栈**：TypeScript + React（web）+ Kotlin（插件）。无新增依赖、无新桥接方法（`ide.repaint` 已存在）。
- **传输**：`POST /bridge` 立即 202，回应与事件走 `GET /bridge/poll` 长轮询；传输层本身不是瓶颈（见上）。
- **存储**：`PiSessionIndex` 结果加内存缓存（进程内，按 `mtime + size` 失效）；不写磁盘缓存。
- **测试**：`vitest`（store 状态机 / 索引逻辑）+ `playwright`（时间阈值断言，靠 mock 注入人为延迟）。
- **平台**：JCEF（Chromium OSR）。帧滞后是已实测过的平台特性，必须显式重绘。
- **性能目标**：T1 ≤150ms、T2 ≤300ms、T3 ≤600ms、T4 ≤1200ms（定义见 spec 验收表）。

## Constitution Check

| 条款 | 本次是否涉及 | 结论 |
|---|---|---|
| I 双端契约同步 | 不新增桥接方法；`sessions.list` 返回结构不变 | 通过 |
| II 断言含几何与行为 | 时间阈值必须由 e2e 用「注入延迟 + 上限断言」固定，不得只断言元素存在 | 通过（见验证命令） |
| III 布局不依赖运行时假设 | 占位/骨架用既有布局占位，不按字体度量推算高度 | 通过 |
| IV 对 pi 写操作可回滚 | `new_session` / `switch_session` 失败必须回滚 UI（US2/US3 明确要求） | 通过 |
| V 桥接双向声明 | 复用既有 `ide.repaint` | 通过 |
| VI 凭据零托管 | 不涉及 | 不涉及 |

无违反项，Complexity Tracking 免填。

## 现状与代码定位

### 前端（`web/src`）

| 位置 | 现状 | 问题 |
|---|---|---|
| `store/store.ts:713-740` `runNewSession` | `await rpc(bridge,{type:"new_session"})` **之后**才 `set({items:[]})`；随后串行 `await refreshStats()` + `await refreshSessions()` | ①②：RPC 期间旧对话原样在屏；且清空后仍要多等两轮，其中 `refreshSessions` 是重活 |
| `store/store.ts:1711-1754` `switchSession` | `await rpc(switch_session)` → 同一笔 `set` 里清 `items` 并 `tab:"chat"` → `await replayMessages()` → `await refreshStats()` → `await rpc(get_state)` | ②③：跳页要等 RPC；跳过去是空白；三个独立 RPC（`get_messages` / `get_session_stats` / `get_state`）串行 |
| `store/store.ts:1964-1975` `replayMessages` | 单次 `get_messages` 后 `set({items})` | 独立于 `get_state`，可并行 |
| `store/store.ts:1136-1142` `setTab` | 切到 sessions 时 `void refreshSessions()` | 与 `SessionsView` 挂载时的 `refreshSessions` 重复触发；靠 `runSource` 的 inflight 短路兜底（`store.ts:587`），列表可能保持旧值 |
| `store/store.ts:585-597` `runSource` | inflight 时静默 `return undefined` | 二次刷新被吞，调用方无法感知「没刷」 |
| `App.tsx:126-134` | 顶层页签点击后 `ide.repaint` | **只有页签点击**触发重绘 |
| `components/ManageView.tsx:41,257` | Manage 子页签切换后 `ide.repaint` | 同上，人工逐个接 |
| `components/SessionsView.tsx:66-68` | 挂载即 `refreshSessions()` | 进入会话页的等待峰值 |
| `components/SessionsView.tsx:183` | 行点击 `void switchSession(s.file)` | 无 pending/禁用/高亮，「点了没反应」 |
| `bridge/jcef.ts:55-100` | 长轮询 20s，`Condition` 唤醒即返回 | 传输层无固定延迟，**不是本次瓶颈** |

### 插件侧（`src/main/kotlin`）

| 位置 | 现状 | 问题 |
|---|---|---|
| `session/PiSessionIndex.kt:42-56` `list` | `root.walkTopDown()` 遍历全部项目，逐文件 `parseHeader`，再按 cwd 过滤 | 成本随**所有项目**历史总量增长 |
| `session/PiSessionIndex.kt:70-130` `parseHeader` | 为拿 name/preview，**每个文件最多解析 4000 行 JSON**（`parsed > 4000` 才跳过），并全文件扫 message 标记 | 非本项目文件也付这份钱；本机 70 文件 / 4.8MB / 14 项目目录 |
| `bridge/BridgeService.kt:474-491` `sessionsList` | 每次调用直接 `list(...)` | 无缓存，`new_session`/rename/delete/进页 都会触发 |
| `bridge/BridgeService.kt:102-114` `handleEnvelope` | 每信封 `scope.launch`（IO） | 并发、不排队 → 不是延迟源，但也意味着重扫会与切换抢 CPU/IO |
| `toolwindow/PiAgentPanel.kt:136-152` console handler | `[pi-agent]` 前缀的 console 消息写 `idea.log`（WARN） | **现成的度量通道，无需新桥接** |
| `toolwindow/PiAgentPanel.kt:453-480` `repaintBrowser` | `revalidate/repaint` + 反射 `CefBrowser_N.wasResized` | 能力已有，只差调用点 |

## 候选根因与证据等级

| # | 候选 | 证据等级 | 依据 |
|---|---|---|---|
| C1 | 界面反馈被 `await` RPC 卡住 | **A（代码事实）** | 两处都是 RPC 之后才写 state |
| C2 | 切换路径三段独立 RPC 串行 | **A** | `replayMessages` / `refreshStats` / `get_state` 依次 await |
| C3 | JCEF OSR 帧滞后，view 变化后无重绘 | **B（真机已证实）** | 0.5.4 run report：DOM 已切、屏幕旧帧挂数分钟；修复仅覆盖页签点击 |
| C4 | `sessions.list` 全树全文件扫描 | **A（代码）+ 本机实测规模** | 70 文件 / 4.8MB / 14 项目；每文件最多 4000 行 JSON 解析 |
| C5 | pi 侧 `new_session` / `switch_session` 自身耗时 | **C（待测量）** | 无法从插件侧消除，只能不阻塞 UI；实测值进执行记录 |

C1–C4 都有确定的修法且互不冲突，因此**不依赖先测出 C5 才动工**；C5 的值只用于判断「修完还剩多少」和是否触发 spec 的拆分条件。

## 设计决策

### D1 乐观切换契约：`pendingSwitch`

store 新增一个「正在切换」状态，点击时**同步**写入，RPC 返回后清除：

```ts
interface PendingSwitch {
  kind: "new" | "history";
  file?: string;          // history 时的目标
  startedAt: number;      // 供埋点与超时提示
}
pendingSwitch: PendingSwitch | null;
```

- 置位时机：确认框通过之后、任何 `await` 之前。
- 清除时机：内容就绪（history）或 pi 确认（new）；失败时也清除并回滚。
- 它是**唯一**的「切换进行中」事实源：占位、禁用发送、行高亮、重复点击守卫都读它，避免多个布尔互相打架。

### D2 新建：立即让位 + 可回滚

`runNewSession` 改造为：

1. 同步 `set({ pendingSwitch, items: [], stats: undefined, ...resetConversationLocalState })`，并保留 `previousItems` 快照（仅在内存，不放进 store 公共字段，避免被误渲染）。
2. 发 `new_session`，**不 await 后才清屏**。
3. 成功后清 `pendingSwitch`；`refreshSessions()` 改为 `void`（不阻塞），并**延迟一拍**发出，避免与首个 `get_state`/`get_messages` 抢带宽。
4. 失败：`set({ items: previousItems })` + `appendError(...)`，清 `pendingSwitch`。

发送禁用的实现沿用既有 `isStreaming` 之外的独立判据 `pendingSwitch != null`（`Composer` 与 `SendButton` 各自读 store，不加新 prop 链）。

### D3 历史切换：先跳页，再填内容

`switchSession` 改造为：

1. 队列确认（005/007 保留）→ 通过后同步 `set({ pendingSwitch, tab: "chat", items: [], stats: undefined, ...重置 outline/search/标题标志 })`，接着 `requestRepaint()`。
2. `if (isStreaming) await abort()` —— abort 放在**跳页之后**，用户先看到目标页，再等中断完成。
3. `await rpc(switch_session)`。
4. `Promise.all([get_messages, get_session_stats, get_state])` —— **三段并行**，结果一次性落库（`items` 与 `sessionName/model/thinkingLevel` 同一笔 `set`，避免闪烁）。
5. 成功清 `pendingSwitch` + `requestRepaint()`；失败回 `tab:"sessions"` + 错误提示 + 清 `pendingSwitch`（Q3 默认口径）。

未就绪期间的占位：`MessageList` 在 `items.length === 0 && pendingSwitch?.kind === "history"` 时渲染 `session.switching` 占位，**不渲染空态**（现有 `EmptyState` 会被误读成「这个会话是空的」）。

### D4 repaint 收敛为单一入口

新增 `web/src/lib/repaint.ts`：

```ts
/** 合并 100ms 内的多次请求；无 bridge 时静默。 */
export function requestRepaint(): void;
```

调用点收敛为三处：顶层页签切换（替换 `App.tsx:126-134` 的裸调用）、`pendingSwitch` 置位、`pendingSwitch` 清除/内容替换。Manage 子页签的既有调用一并改走它。

去抖的理由：一次切换会连着改两次 view（跳页 + 内容替换），两次 `wasResized` 反射调用会互相打架；100ms 内合并成一次即可，且不改变「切完一定重绘」的语义。

### D5 会话索引：两阶段读取 + 进程内缓存

`PiSessionIndex.list` 改两阶段：

1. **先读首行**取 `cwd`/`id`/`timestamp`（pi 的 session 头一定是第一行）。cwd 不匹配 → 立即放弃，不再读剩余行。
2. 只有 cwd 匹配才继续读 name/preview/messageCount（沿用 4000 行上限）。
3. 结果按 `File → (lastModified, length) → SessionSummary?` 缓存；两者都没变则直接复用。`null`（解析失败）也缓存，避免反复踩同一个坏文件。
4. 缓存挂在 `object PiSessionIndex`（进程级），条目数上限按项目数×会话数自然有界；`limit=100` 语义不变。

不采用「按目录名猜项目」的捷径：目录名会出现 8.3 短名（本机实测存在 `--C--Users-ADMINI~1-AppData-...--`）与大小写差异，头行 cwd 才是权威。

### D6 度量：走现成的 console → idea.log 通道

`web/src/lib/perf.ts`：

```ts
/** 以 `[pi-agent] perf <event> <ms>` 单行输出；JCEF console handler 会写进 idea.log。 */
export function perfMark(event: string, startedAt: number, extra?: Record<string, string | number>): void;
```

四个固定事件名：`switch.tap`（点击时刻基线）、`switch.pending`（界面已反馈）、`switch.content`（内容就绪）、`switch.ready`（可再次发送）。取值方式：`grep "\[pi-agent\] perf" idea.log`。

不引入新桥接、不引入 `performance.measure` 面板依赖（JCEF 里 DevTools 不保证可用）。

### D7 e2e 用「注入延迟」而不是「实测时间」

mock 的 `?slow=` 现在只作用在 source id（`mock.ts:207-209,372-376`），扩展到 **rpc 命令名**：

```
?slow=switch_session:1200,get_messages:400,new_session:1200
```

语义与既有保持一致（默认只慢**第一次**，与 `?fail=` 同源 `parseFailPlan`）。这样断言变成「在 1200ms 的 RPC 里，tab 仍在 150ms 内切过去并显示占位」，与机器快慢无关。

### D8 竞态与幂等

- 连点两行：`switchSession` 内部维护自增 `switchSeq`，响应回来时 `seq !== current` 直接丢弃（沿用 006 的 `sessionSearchSeq` 写法）。
- 连点「新建」：`pendingSwitch != null` 时直接 return（不再发第二个 `new_session`）。
- `pendingSwitch` 超过 10s 未清除：保留占位但把提示改为「仍在切换…」，不自动回滚（pi 慢不等于失败）。

## 改造前后时序

```
改造前（历史切换）：
点击 ─ 0ms
   ├─ await switch_session ················ 400ms
   ├─ set(tab=chat, items=[]) ──────────── 400ms（此刻才跳页，且是空白）
   ├─ await get_messages ················· 250ms
   ├─ await get_session_stats ············  40ms
   └─ await get_state ····················  40ms
                                          ≈ 730ms + 旧帧残留（OSR）

改造后（历史切换）：
点击 ─ 0ms
   ├─ set(pendingSwitch, tab=chat, items=[]) + repaint ── ≤16ms（T1/T2 ✓）
   ├─ await abort（仅流式时）
   ├─ await switch_session ··············· 400ms
   ├─ await Promise.all([messages, stats, state]) ····· 250ms（取最大，不累加）
   └─ set(items…, pendingSwitch=null) + repaint ──────── ≈ 666ms（T3 ✓）
```

## 接口契约

```ts
// web/src/store/store.ts
export interface PendingSwitch { kind: "new" | "history"; file?: string; startedAt: number }
// PiStore 新增：
pendingSwitch: PendingSwitch | null;
```

```ts
// web/src/lib/repaint.ts
export function requestRepaint(): void;   // 100ms 去抖，内部 request("ide.repaint")

// web/src/lib/perf.ts
export function perfMark(event: "switch.tap" | "switch.pending" | "switch.content" | "switch.ready",
                         startedAt: number, extra?: Record<string, string | number>): void;
```

```kotlin
// src/main/kotlin/dev/pi/agent/session/PiSessionIndex.kt
object PiSessionIndex {
    fun list(projectPath: String, limit: Int = 100, rootOverride: File? = null): List<SessionSummary>  // 签名不变
    // 内部新增：parseCwdHeader(file): Triple<cwd, id, timestamp>? 与 cache
}
```

桥接契约零变化：`sessions.list` 的请求/响应结构、`ide.repaint` 的入参出参都不动。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/store/store.ts` | `PendingSwitch` 状态；`runNewSession` / `switchSession` 改乐观 + 并行 + 回滚；`switchSeq` 守卫 |
| `web/src/store/types.ts` | `PiStore` 增 `pendingSwitch`（状态形状声明） |
| `web/src/lib/repaint.ts`（新） | 去抖重绘入口 |
| `web/src/lib/perf.ts`（新） | 单行度量输出 |
| `web/src/components/MessageList.tsx` | 切换中的占位（不渲染空态） |
| `web/src/components/SessionsView.tsx` | 行点击后立即高亮/禁用重复点击（读 `pendingSwitch`） |
| `web/src/App.tsx` | 页签切换的 repaint 改走 `requestRepaint()` |
| `web/src/components/ManageView.tsx` | 同上（两处） |
| `web/src/components/Composer.tsx` / `SendButton.tsx` | `pendingSwitch != null` 时禁用发送 + 提示 |
| `web/src/i18n/locales/en.ts` / `zh.ts` | `session.switching`、`session.switchingLong`、`session.switchFailed` |
| `web/src/bridge/mock.ts` | `?slow=` 支持 rpc 命令名；`switch_session` / `new_session` 默认实现保持 |
| `web/e2e/sessions.spec.ts` / `e2e/layout-regressions.spec.ts` | 新增 T1/T2 阈值用例、回滚用例、连点用例 |
| `src/main/kotlin/dev/pi/agent/session/PiSessionIndex.kt` | 两阶段读取 + 缓存 |
| `src/test/kotlin/dev/pi/agent/session/PiSessionIndexTest.kt` | 跨项目跳过、缓存命中/失效、坏文件 |

## 顺序与依赖

```
阶段 A 新建轨道（T301–T304）── 只动前端，风险最低，可先单独进 0.5.7
      ↓（共用 pendingSwitch）
阶段 B 历史切换轨道（T305–T310）── 依赖 A 的状态契约
      ↓
阶段 C 会话索引（T311–T313）── 与 A/B 并行无冲突（Kotlin 侧独立）
      ↓
阶段 D 度量与收尾（T314–T317）── 阈值断言、真机取值、文档
```

不可颠倒的只有一条：`pendingSwitch` 的形状先定（D1），A/B 两轨都以它为准。

## 风险与降级

| 风险 | 缓解 |
|---|---|
| 乐观清空后 pi 报错，用户以为对话丢了 | 失败回滚快照 + 错误项（D2）；回滚用例进 e2e |
| pi 侧 `new_session` 本身就 ≥1s（C5） | 只影响 T4，不影响 T1–T3；实测值写进执行记录，达到 800ms 即触发 spec 的拆分条件、另立规格 |
| 并行化后 `set` 落库顺序变化导致状态闪烁 | 三份结果合并成一笔 `set`（D3 第 4 步） |
| 去抖重绘吞掉「内容替换后」的重绘 | 去抖窗口 100ms 且以最后一次为准；若真机仍见旧帧，去抖降为「首次立即 + 后续合并」 |
| `PiSessionIndex` 缓存与外部改名不一致 | 缓存键含 `lastModified + length`；rename 会改文件 → 自然失效；另有 `limit` 语义保护 |
| 长会话（数百条消息）渲染仍慢 | 本 spec 不引虚拟列表；T3 阈值只对 ≤110 条消息的会话设门槛，超出的作为 D 阶段实测记录 |

## 验证命令

```bash
cd web
npx tsc --noEmit                                  # 0 错误
npx vitest run src/store/store.test.ts            # pendingSwitch / 回滚 / 连点守卫
npx playwright test e2e/sessions.spec.ts           # T1/T2 阈值 + 回滚（注入 1200ms 延迟）
npx playwright test                                # 全量零回归
cd .. && ./gradlew test --tests "*PiSessionIndexTest*"   # 索引两阶段 + 缓存
```

阈值断言写法（宪法第 II 条，必须带数字）：

```ts
// 注入 1.2s 的 switch_session 延迟后，界面仍必须立刻反馈
await page.getByTestId("session-row").nth(1).click();
await expect(page.getByTestId("tab-chat")).toHaveClass(/tab-active/, { timeout: 150 });
await expect(page.getByTestId("session-switching")).toBeVisible({ timeout: 300 });
```

几何无关，但**必须**同时断言「占位不是空态」：`expect(page.getByTestId("empty-state")).toHaveCount(0)`。
