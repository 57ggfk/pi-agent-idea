# Implementation Plan: 019 工具窗多实例

**Branch**: `release/0.5.7` | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)
**Tasks**: 待拆分（本 plan 只定方案与阶段边界；不含 task 编号）

## 摘要

把「一个项目一个 pi 进程、一个浏览器」的单例结构，改成「一个项目 N 个实例」的注册表结构。载体用平台原生的 multi-Content 工具窗：每个 Content 装一个 `PiAgentPanel`（独立 JCEF 浏览器 → 独立 React 应用），每个实例对应一个独立 `pi --mode rpc` 进程。核心改动集中在 Kotlin 三处（进程管理器、桥接服务、事件缓冲），web 侧只跟随实例号回传请求。

模块级替换，不做并存方案：`PiProcessManager` 内部从「两个 `AtomicReference`」换成注册表，对外保留无参门面（等价实例 1），因此单实例路径的调用点零改动。

## 技术上下文

- **语言/栈**：宿主 Kotlin；`PiAgentToolWindowFactory` 保持 **Java**（Kotlin 实现 `ToolWindowFactory` 会产生 jvm-default 前向方法，被 verifier 记成 internal API usage —— 见该文件类注释，不要顺手改写成 Kotlin）。
- **UI 载体**：`ToolWindow` + `ContentManager`（multi-Content，Run 窗口同款），每个 Content 一个 `PiAgentPanel`。
- **进程**：`pi --mode rpc`，stdio JSONL；每实例一条 stdin/stdout，天然无端口冲突。
- **通信**：loopback HTTP + 长轮询（`POST /bridge`、`GET /bridge/poll`），project 级随机 token 鉴权。
- **测试**：Kotlin 单测（注册表建/停/键冲突/Dispose 清理/事件路由）+ 真机清单（playwright 不覆盖 IDE 侧多实例）。
- **约束**：默认只开一个实例时，既有 e2e 与真机行为零变化；不新增 RPC 方法名；不改 pi 的启动参数结构。

## Constitution Check

| 条款 | 涉及点 | 结论 |
|---|---|---|
| I 双端契约同步 | 请求与事件新增实例号字段，web 侧 `bridge/types.ts` 与 Kotlin 信封必须同一次改；缺省值两侧都是 1 | 通过（D4 明确缺省规则） |
| II 断言含几何与行为 | 本 feature 无新增自绘 UI（标签条是平台原生），几何断言不适用；改用「隔离性」行为断言：A 的事件不出现在 B 的缓冲 | 通过（D6 的缓冲隔离要有单测） |
| III 布局不依赖运行时假设 | 不涉及自绘布局 | 不涉及 |
| IV 对 pi 写操作可回滚 | 只启停进程，不写 `~/.pi/agent` | 不涉及 |
| V 桥接双向声明 | 新增的是 HTTP query 参数与会话字段，不是新 RPC 方法；`types.ts` 仍需同步 | 通过 |
| VI 凭据零托管 | 每实例各自读 `auth.json`，不缓存凭据 | 不涉及 |

无违反项，Complexity Tracking 免填。

## 现状与代码定位

| 位置 | 现状 | 多实例下会怎样 |
|---|---|---|
| `process/PiProcessManager.kt:69-70` | 单个 `processRef` / `clientRef`（AtomicReference） | 第二个实例会覆盖第一个的进程引用，第一个变孤儿 |
| `:79-92` | `stateListeners` / `eventListeners` 各一个集合 | 所有监听者收到所有实例的事件 |
| `:94-98`、`:100`、`:208` | `client()` / `start()` / `restart()` 无实例维度 | 无法表达「启动第 2 个实例」 |
| `:237`、`:255` | `shutdownProcess` / `dispose` 只处理单进程 | 退出时漏杀进程 |
| `bridge/BridgeService.kt:62` | `transport = BridgeTransport()`（project 级单条事件流） | 两个浏览器消费同一条流，互相看到对方的事件 |
| `:73` | `messageQueueField` 单镜像 | 队列状态跨实例串台 |
| `:97`、`:1030` | `wiredLock` / `ensureWired` 只 wire 一次 | 第二个实例的 pi 事件没有监听者 |
| `:1021-1027` | `pollEvents(cursor)` / `currentSeq()` / `oldestSeq()` 无实例参数 | 前端无法只取自己的事件 |
| `bridge/BridgeTransport.kt:25` | 单个 `ConcurrentLinkedDeque` + 单条 seq 链 | 同上；且 `sinceLastPollMs()` 是单值 → 健康检查会误判（A 的页面在轮询，B 也被认为在线） |
| `ui/LocalUiServer.kt:129-145` | `POST /bridge` 直接 `handleEnvelope(body)` | 无法知道请求属于哪个实例 |
| `ui/LocalUiServer.kt:146-180` | `/bridge/poll` 只读 `cursor` / `timeout` | 同上 |
| `toolwindow/PiAgentPanel.kt:51` | `JPanel + Disposable`，无实例身份 | 无法在 URL 上标注实例号 |
| `PiAgentPanel.kt:386`、`:419` | `startHealthWatch` / `rebuildAfterCrash` 作用于自身 | 天然按实例，无需改（但依赖 D6 的分桶轮询时间） |
| `java/.../PiAgentToolWindowFactory.java:36-44` | 建一个 Content，`Disposer.register(content, panel)` | 需要「新建实例」路径复用同一段建 Content 逻辑 |
| `src/main/resources/META-INF/plugin.xml:30-34` | `canCloseContents="false"` | 标签不可关闭，与 US1「关闭标签 = 结束实例」冲突，必须改 `true` |
| `toolwindow/PiStatusWidget.kt:40,54` | 读 `PiProcessManager.getInstance(project).state` | 多实例后「状态」有歧义 |

## 与 spec 初版的两处偏差（实现前先对齐）

1. **「web 侧零改动」不成立**。浏览器必须知道自己是第几个实例，否则 Kotlin 无法把请求路由到对应进程（同一 project 的 token 相同，服务端仅凭 token 分不出实例）。改动压到最小：页面 URL 带 `?instance=N`，前端把它拼进 `POST /bridge?instance=N` 与 `GET /bridge/poll?instance=N&cursor=…`。`store`、组件、渲染全部不动。
2. **关闭标签的确认框不能复用 web 的 `ConfirmDialog`**。关闭 Content 是 IDE 侧动作，页面即将销毁，无法等它的异步回答。改用 IDE 原生 `Messages.showYesNoDialog`（文案走 `PiAgentBundle`，中英双语），语义仍是「确认后中断并关闭」。

## 设计决策

### D1 实例注册表

`PiProcessManager` 内部改为 `ConcurrentHashMap<Int, InstanceSlot>`，`InstanceSlot` 持有该实例的全部可变状态：

```kotlin
private class InstanceSlot(val id: Int) : Disposable {
    val processRef = AtomicReference<Process?>(null)
    val clientRef = AtomicReference<PiRpcClient?>(null)
    val stateListeners = CopyOnWriteArrayList<(PiConnectionState) -> Unit>()
    val eventListeners = CopyOnWriteArrayList<(JsonObject) -> Unit>()
    @Volatile var state: PiConnectionState = PiConnectionState.Idle
}
```

`id` 从 1 起、取最小未占用号（关闭 2 号后再开，复用 2 —— 与标签命名 `Pi 2` 一致）。

### D2 兼容门面

保留无参 `client()` / `start()` / `restart()` / `state` / `addStateListener` 等，内部转发到实例 1（不存在则创建）。这样 `PiStatusWidget`、`BridgeService` 的既有单实例调用点不需要一次性全改，重构可以分步落地。

新增带 `instanceId` 的重载才是多实例路径。

### D3 事件缓冲按实例分桶

`BridgeTransport` 从「一条流」改为「每实例一条流」：

- `BridgeTransport` 内部按 `instanceId` 维护独立的 `seq` 与 `ConcurrentLinkedDeque`，`push(instanceId, record)`、`pollAfter(instanceId, cursor, timeout)`、`currentSeq(instanceId)`、`oldestSeq(instanceId)`、`sinceLastPollMs(instanceId)`。
- 单实例项目与现在完全等价（只有一个桶）。
- 桶在实例关闭时随 slot 一起清理，避免 seq 无限增长。

**这是隔离的核心**：两个浏览器各自 cursor 只在各自的桶里推进，不会互相消费。

### D4 实例号随请求走

- `PiAgentPanel(project, instanceId)`：加载页面时拼 `?instance=N`（保留既有 `?token=…` 等参数）。
- web 侧新增一个模块级常量（启动时从 `location.search` 读一次 `instance`，缺省 1），在 `POST /bridge` 与 `/bridge/poll` 的 URL 上追加 `instance`。
- Kotlin 侧 `LocalUiServer` 解析 `instance`（缺省 1、非数字或缺省都回落 1），传给 `handleEnvelope(body, instanceId)` / `pollEvents(instanceId, cursor, timeout)`。
- **信封里不再增加字段**：实例归属由 HTTP 层决定，web 侧信封结构零变更（比在 `types.ts` 加字段更省事、也不会因版本错配而错投）。

### D5 队列镜像逐实例

`messageQueueField` 从 `BridgeService` 字段下沉到实例维度（`Map<Int, PiMessageQueue>`，或在 slot 内部持有）。`queue.*` 系列 RPC 按请求的实例号取对应镜像，`queue` 事件只推给该实例的桶。

### D6 健康检查与崩溃重建保持 per-panel

`PiAgentPanel` 已经自带 `startHealthWatch` / `rebuildAfterCrash`，天然按实例作用。唯一要改的是数据源：`sinceFrontendPollMs()` 必须按实例分桶（D3），否则 A 的页面在轮询会让 B 的健康检查误判「页面还活着」。

`rebuildAfterCrash` 只重建自己的浏览器；**不重启 pi 进程**（与现状一致）。

### D7 Content 生命周期与关闭确认

- `plugin.xml` 的 `canCloseContents` 改为 `true`。
- 工厂抽出 `createInstanceContent(project, toolWindow, instanceId)`，首个 Content 与「+」新建共用。
- 关闭 Content：`ContentManagerListener.contentRemoved` → 若该实例正在流式，先弹 `Messages.showYesNoDialog`（「实例正在生成，关闭会中断当前回复」）；用户取消则把 Content 加回去（`contentManager.addContent`）。
- `Disposer.register(content, panel)` 保持；额外把 slot 注册到 panel 的 Disposable 链，确保进程与桶一起回收。

### D8 数量上限 4

常量 `MAX_INSTANCES = 4`。达到上限时「+」置灰 + `tooltip`（走 `PiAgentBundle`）。上限只挡新建，不挡已有实例。

### D9 标签命名与可选改名

默认标题 `Pi 1 / Pi 2 / …`（取最小未占用号）。改名存 `PropertiesComponent` 键 `pi.instance.<n>.name`，只在用户主动改名时写；实例关闭不清理（下次复用该号时沿用，符合「标签位置记忆」直觉）。

### D10 进行中标记

实例状态变化时更新对应 `Content` 的图标/标题（`Content.setIcon` + 可选斜体不可用，改用 `setDisplayName` 前缀或 `setIcon` 换活动图标）。只在「流式中」与「空闲」两态切换，避免频繁重绘。

### D11 状态栏与启动活动

`PiStatusWidget` 显示**当前活跃实例**的状态（`ContentManager` 的 selected content 变化时更新），tooltip 里带「Pi 2 / 共 2」。`PiAgentStartupActivity` 不变（只是激活工具窗，落在默认实例上）。

### D12 项目关闭

`PiProcessManager.dispose` 遍历所有 slot：先 `shutdownProcess`，再清监听器与桶；`BridgeService` 的 transport 桶同样清空。顺带修掉现状「漏杀第 N 个进程」的可能。

## 协议与结构变更一览

| 层 | 变更 | 兼容规则 |
|---|---|---|
| 页面 URL | `/?…&instance=N` | 缺省 1 |
| `POST /bridge` | 新增 query 参数 `instance` | 缺省 1 |
| `GET /bridge/poll` | 新增 query 参数 `instance` | 缺省 1 |
| 信封 / 事件 JSON | **不变** | — |
| 事件桶 | `instanceId → {seq, deque, lastPollAt}` | 单实例等价现状 |
| 进程 | `instanceId → {process, client, listeners, state}` | 无参 API 转发实例 1 |

## 触及文件

| 文件 | 改动 |
|---|---|
| `src/main/kotlin/dev/pi/agent/process/PiProcessManager.kt` | 单例→注册表（D1/D2/D12）；`PiStartArgs` 不变 |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeTransport.kt` | 按实例分桶（D3） |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | `transport` 分桶调用、队列镜像下沉、`handleEnvelope`/`pollEvents` 加实例号（D4/D5） |
| `src/main/kotlin/dev/pi/agent/ui/LocalUiServer.kt` | `/bridge`、`/bridge/poll` 解析 `instance` |
| `src/main/kotlin/dev/pi/agent/toolwindow/PiAgentPanel.kt` | 构造带 `instanceId`，URL 拼参数（D4） |
| `src/main/java/dev/pi/agent/toolwindow/PiAgentToolWindowFactory.java` | 抽 `createInstanceContent`、「+」动作、关闭监听（D7/D8） |
| `src/main/resources/META-INF/plugin.xml` | `canCloseContents="true"`；新增「+」action 注册（如需） |
| `src/main/kotlin/dev/pi/agent/toolwindow/PiStatusWidget.kt` | 活跃实例聚合（D11） |
| `src/main/resources/messages/PiAgentBundle.properties` | 新增上限提示、关闭确认、工具提示文案（中英） |
| `web/src/bridge/client.ts`（或等价发起请求处） | 读 `location.search` 的 `instance` 并回传（D4，web 侧唯一改动） |
| `src/test/kotlin/...` | 注册表与分桶的单测（新建） |

## 实现顺序

```
阶段 0 取证（真机，半天）
  - ContentManager 在 2.10 的 canCloseContents / contentRemoved 行为
  - 两个 Content 各自加载页面时，LocalUiServer 能否区分（token 相同）
      ↓
阶段 1 注册表重构（单实例零回归）
  - D1/D2/D12：先让既有调用点原样跑通，全量测试与真机冒烟
      ↓
阶段 2 事件分桶 + 请求带实例号
  - D3/D4/D5：单实例仍零变化；用两个浏览器手工验证互不串台
      ↓
阶段 3 多 Content UI
  - D7/D8/D9/D10：+、关闭确认、上限、命名、进行中标记
      ↓
阶段 4 收尾
  - D11 状态栏、真机清单、CHANGELOG、MANUAL_TEST
```

不可颠倒：**阶段 1 必须先让单实例全绿**，否则后面的隔离问题无法区分是注册表还是分桶引起的。

## 测试策略

**Kotlin 单测**（新增，锁死注册表语义）
- 建实例 → 取最小未占用号；关闭 2 号后再建复用 2 号。
- 两个实例各自 `start()` 后，`client(1) != client(2)`，`stop(1)` 不影响 2。
- 事件路由：向实例 2 推事件，实例 1 的监听器收到 0 条。
- `dispose()` 后所有 slot 清空、所有监听器解绑。
- 桶隔离：`pollAfter(1, cursor)` 不返回实例 2 的记录；`sinceLastPollMs(2)` 不受实例 1 轮询影响。

**真机清单**（`MANUAL_TEST.md` 单列）
1. 开两个实例，A 发长任务，B 立刻发短任务 → 两条回复各归各位，不串台。
2. A 流式中点 B 的「+」再发消息 → B 正常，A 的流不受影响。
3. 关 B（流式中）→ 弹原生确认；取消则 Content 回来且流继续；确认则进程结束。
4. 关 A 留 B → B 的连接状态与队列不受影响。
5. 开满 4 个 → 「+」置灰 + tooltip；关一个后可再开。
6. 杀掉 A 的 pi 进程 → 只有 A 显示崩溃并重建，B 不动。
7. 关闭 IDE → 无残留 pi 进程（任务管理器核对）。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 注册表重构破坏单实例（最大风险） | 整个插件不可用 | 阶段 1 单独锁定：全量 `gradlew test` + 真机单实例冒烟通过后才进阶段 2 |
| 事件分桶遗漏某个 `push` 调用点 | 某类事件只投给实例 1 | `BridgeService` 内所有 `push(...)` 收敛到一个带 `instanceId` 的私有方法，编译期强制带参 |
| 关闭 Content 的时序（取消后重新添加） | 标签丢失或重复 | 阶段 0 先真机确认 `contentRemoved` 行为，取消路径用 `contentManager.addContent` 复原并保留原 Disposable |
| 状态栏歧义 | 用户看到的状态与自己正在看的实例不一致 | D11 明确「活跃实例」并在 tooltip 标注序号与总数 |
| 内存翻倍（每实例一个 JCEF） | 4 个实例时占用高 | 默认只开 1 个；上限 4；`PiAgentPanel` 的 `dispose` 已有回收链 |

## 复杂度追踪

无宪法违反项，免填。

## 交付边界

阶段 1–2 完成即可交付「后台支持多实例」，阶段 3 完成才是用户可用的多标签。若时间不足，倾向**先合阶段 1–2**（对外行为不变、风险最低），阶段 3 单独评审后再上线——但注意 `canCloseContents` 一旦改为 `true` 而阶段 3 未完成，用户会看到可关闭却无法新建的半成品，因此 `canCloseContents` 的改动必须与「+」按钮同批。
