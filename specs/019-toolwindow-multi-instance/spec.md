# 019 工具窗多实例——一个 Pi Agent 工具窗内开多个 pi 实例

> 来源:用户 2026-11-10 需求——一个 tool window 内开多个 pi 实例(并行对话)。
> 版本归属:0.5.7,排在 018 之后实现(架构级改动,独立评审/独立交付)。关联:spec 009(桥接/事件通道)、018(同批次前端件)。

## 调研结论(决定方案的关键事实)

1. **现状是单例写死的**:`PiProcessManager`(project 级服务)内只有一个 `clientRef: AtomicReference<PiRpcClient?>`;`BridgeService` 单事件缓冲、单队列镜像,pi 事件广播给「唯一的」浏览器;`PiAgentPanel` 一个 JCEF 浏览器,自带 Disposable 与崩溃重建(`rebuildAfterCrash`)。
2. **原生载体是 multi-Content tool window**(Run 窗口同款):一个工具窗、N 个 Content 标签,平台自带 tab 条/关闭/激活。每个 Content 装一个独立 `PiAgentPanel` = 独立 JCEF 浏览器。
3. **每 Content 独立浏览器 ⇒ web 侧零改动**:每个浏览器是一份隔离的 React 应用(自带 store/会话/草稿),不需要在 web 层做实例路由;改动全部在 Kotlin 侧。
4. **隔离的正确切面是「实例」而非「标签」**:每个实例 = 独立 pi `--mode rpc` 进程(stdio,无端口冲突)+ 独立事件流 + 独立浏览器。pi 进程多开无共享状态问题(会话 jsonl 各自独立);项目级 Preferences(上次模型等)共享属预期行为。
5. **向后兼容必须留**:envelope/事件带 `instanceId`,缺失时默认实例 1——防止 web 与 IDE 版本错配时旧页面白屏。

## User Stories

### US1 实例标签的创建/关闭/切换

工具窗内出现原生 Content 标签条;「+」按钮(标签条尾)新建实例,自动命名 `Pi 1 / Pi 2 / …`(取最小未占用号);关闭标签 = 结束该实例 pi 进程并释放浏览器;切标签即切换浏览器焦点(平台行为,无自定义)。**上限默认 4 个**(每个 JCEF 浏览器内存开销大),到顶「+」置灰 + tooltip 说明。

### US2 实例隔离(核心)

- `PiProcessManager` 重构为按 `instanceId` 的注册表:`client(instanceId)`、`start/stop(instanceId)`、状态/事件监听按实例注册;旧无参 `client()` 保留为「实例 1」兼容门面。
- `BridgeService`:`ide` 事件的投递目标按 `instanceId` 路由到对应浏览器(现状:广播给唯一浏览器);每实例独立事件缓冲与队列镜像;RPC 调用在 envelope 中携带 `instanceId`,Kotlin 侧按它选进程。
- 验收口径:实例 A 的流式回复/排队/中断不出现在实例 B;A 中断不影响 B;一边流式一边另一边可正常发送。

### US3 实例生命周期

- 关闭标签时该实例流式进行中 → 007 ConfirmDialog 确认(默认口径:确认后中断并关闭);非流式直接关。
- 崩溃重建(`rebuildAfterCrash`)只影响本实例,其他实例不动;健康监控(`startHealthWatch`)按实例跑。
- IDE 关闭/工程关闭:全部实例进程与浏览器回收(现有 Disposable 链逐实例执行)。

### US4 状态可见

- 标签标题:自动号 + 可通过标签右键改名(可选,默认做——成本仅一个存储键);流式进行中的实例标签显示进行中标记(图标/斜体)。
- 每实例独立的连接状态条与安装引导(012 US4 的独占引导按实例生效,检测失败不锁死其他实例)。

## 非目标

- 实例间共享/迁移会话、跨实例 fork。
- 实例级工作目录/分支绑定(一律项目根);跨项目实例(工具窗本就 per-project)。
- 自绘 tab 条/分屏/浮动窗口(用平台原生 Content)。
- web 层多实例路由(per-Content 浏览器已隔离,不做)。

## 风险与回归面

- **单实例零回归是硬约束**:默认只开一个实例时,现有 e2e(mock 驱动的 web 测试)与真机行为不变;envelope 兼容规则(缺 instanceId → 实例 1)保证新旧配对可用。
- `PiProcessManager` 重构是最大风险点:注册表键管理、逐实例清理、状态监听错投——以 Kotlin 单测锁死(建/停/键冲突/Dispose 清理),真机验证多开内存与隔离。
- e2e(playwright)不直接覆盖多实例(那是 IDE 侧行为);真机清单单列:双开互不串扰、双流式并行、关一留一、4 上限、崩溃只倒一个。
