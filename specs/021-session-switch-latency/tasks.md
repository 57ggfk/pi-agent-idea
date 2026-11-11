# 021 tasks

> 状态：**已实现**（2026-11-11）。A/B/C/D 四轨全部落地，单测 + e2e 全绿。
> 两处按实现调整：① T309 的行级 `aria-busy`/disabled 已实现，但切换是**同一 tick** 内跳页，
> 列表随即消失，e2e 无法观察到该状态 → 改由 store 单测覆盖（`pendingSwitch.file` 命中目标）。
> ② T310 的 `session.switchFailed` 未新增，复用既有 `error.switchSession.failed`（避免同义键并存）；
> `session.switching`/`session.switchingLong` 已按计划新增。
> 顺序即编号，串行执行。web 单测 `npx vitest run`，e2e `npx playwright test`，类型 `npm run typecheck`，Kotlin `./gradlew test`。
> 技术方案、时序、接口契约一律以 [plan.md](./plan.md) 为准；本文只排顺序与验证方式。
> 每条 task 自带「— 验证：…」；无断言覆盖的实现不得标记完成（宪法第 II 条）。
> **A 轨（T301–T304）可单独交付**；B 轨（T305–T310）体量更大，必要时随 0.5.8 走（spec「拆分判断」已写明触发条件）。

## A. 状态契约与新建轨道

- [x] **T301** [US1] 新增 `web/src/lib/repaint.ts`：`requestRepaint()` 内部 100ms 去抖后 `request("ide.repaint")`，无 bridge 时静默；把 `App.tsx:126-134`、`ManageView.tsx:41,257` 三处裸调用改走它 — 验证：`vitest` 覆盖「100ms 内 3 次调用只发 1 次」「无 bridge 不抛」；e2e 全量重绘相关用例零回归（Manage 子页签、顶层页签）
- [x] **T302** [US1] store 增 `pendingSwitch: PendingSwitch | null`（`{kind:"new"|"history", file?, startedAt}`）与 `switchSeq` 自增守卫；`types.ts` 同步声明 — 验证：`store.test.ts` 断言初始为 `null`；`newSession()` 置位后 `kind==="new"`、`switchSession(f)` 置位后 `file===f`
- [x] **T303** [US2] 重写 `runNewSession`：确认通过后**先**同步 `set({pendingSwitch, items: [], stats: undefined, sessionName: undefined, ...resetConversationLocalState})` 并 `requestRepaint()`，再 `await rpc(new_session)`；失败 `set({items: 快照})` + `appendError` + 清 `pendingSwitch`；成功清 `pendingSwitch` 并把 `refreshSessions()` 改为 `void`（延迟一拍）— 验证：单测用「延迟 800ms 的 `rpc.request`」断言 `set` 在 RPC **之前**发生（mock 记录调用顺序：`items=[]` 早于 `rpc.request` 解析）；失败用例断言 `items` 恢复为原条数与内容
- [x] **T304** [US2] `Composer.tsx`/`SendButton.tsx`：`pendingSwitch != null` 时发送按钮禁用并显示 `session.switching` 提示（Q2：输入框仍可打字）；`doSend` 内加同等守卫 — 验证：e2e 注入 `?slow=new_session:1200`，确认后 ≤150ms 出现空态、发送按钮 `disabled`、1200ms 后自动恢复可用

## B. 历史切换轨道

- [x] **T305** [US3] 重写 `switchSession` 开头：队列确认（005/007 原样）→ 同步 `set({pendingSwitch, tab:"chat", items: [], stats: undefined, 重置 outline/search/标题标志})` + `requestRepaint()`，**之前**的 `if (isStreaming) await abort()` 移到跳页之后 — 验证：单测断言 `tab==="chat"` 与 `items=[]` 在 `rpc.request(switch_session)` 解析前已发生；流式场景断言 `abort` 调用发生在 `tab` 变更之后
- [x] **T306** [US3] 三段独立 RPC 并行：`Promise.all([get_messages, get_session_stats, get_state])`，结果合并**一笔** `set`（items + sessionName/sessionId/model/thinkingLevel）；`replayMessages` 与 `refreshStats` 保留（供其他调用方复用），切换路径不再分别 await — 验证：单测断言三者的 `rpc.request` 起始时间差 <20ms（并行）且只有一次 `set` 同时含 `items` 与 `sessionName`（无中间闪烁帧）
- [x] **T307** [US3] `MessageList.tsx`：`items.length === 0 && pendingSwitch?.kind === "history"` 时渲染 `data-testid="session-switching"` 占位（文案 `session.switching`），**不渲染** `empty-state` — 验证：e2e 注入 `?slow=switch_session:1200`，点击行后 ≤150ms `tab-chat` 激活、≤300ms `session-switching` 可见，且 `empty-state` 计数为 0
- [x] **T308** [US3] 失败与竞态：`switch_session` 抛错 → `set({tab:"sessions", items: []})` + `appendError(session.switchFailed)` + 清 `pendingSwitch`（Q3 默认）；响应回来时 `seq !== current` 直接丢弃；`pendingSwitch` 超 10s 把提示换成 `session.switchingLong` — 验证：单测覆盖失败回列表、A→B 连点时 A 的迟到响应被丢弃（最终 `switchSession` 目标为 B）、10s 文案切换（fake timers）
- [x] **T309** [US3] `SessionsView.tsx`：行按钮读 `pendingSwitch`，命中的行加 `aria-busy` + `session-pending` 类，其他行 `disabled`（防连点）— 验证：e2e 断言点击后目标行有 `aria-busy="true"`、其余行 `disabled`
- [x] **T310** [US3] i18n：`session.switching` / `session.switchingLong` / `session.switchFailed` 进 `en.ts` + `zh.ts` — 验证：`npm run typecheck` 0 错误；字典键对齐测试通过；界面切换语言后备两处文案都在

## C. 会话索引（Kotlin）

- [x] **T311** [US4] `PiSessionIndex.parseHeader` 拆两阶段：先只读首行取 `cwd/id/timestamp`，cwd 不匹配立即返回 null（不再读剩余行）；匹配才继续 name/preview/messageCount — 验证：`PiSessionIndexTest` 用 3 个假项目各 2 个会话，断言只返回目标项目的 2 条；用「首行非 session 类型」的坏文件断言返回 null 且不抛
- [x] **T312** [US4] 结果缓存 `ConcurrentHashMap<File, CacheEntry(lastModified, length, SessionSummary?)>`，键值都没变则复用；`null` 也缓存 — 验证：同一次 `list` 连调两次，第二次不触发文件读取（用只读临时目录 + 读后 `setLastModified` 变化断言失效重算）
- [x] **T313** [US4] `BridgeService.sessionsList` 保持契约不变（字段/排序/limit=100）；`new_session` 后的刷新不再落在切换关键路径上（配合 T303）— 验证：`./gradlew test` 全绿；现有 `sessions.list` 相关单测不改断言即通过

## D. 度量与收尾

- [x] **T314** [US5] 新增 `web/src/lib/perf.ts`：`perfMark(event, startedAt, extra?)` 输出单行 `[pi-agent] perf <event> <ms> …`（JCEF console handler 已把该前缀写 idea.log）；在点击、`pendingSwitch` 置位、内容就绪、可再次发送四处埋点 — 验证：单测断言输出格式（`console.log` spy）、`extra` 键值序列化稳定；真机 `grep "\[pi-agent\] perf" idea.log` 能看到四个事件名
- [x] **T315** [US5] mock 的 `?slow=` 扩展到 rpc 命令名（`switch_session` / `new_session` / `get_messages` / `get_session_stats` / `get_state`），语义与 `?fail=` 一致（默认只慢第一次）— 验证：`bridge/mock.test.ts` 断言 `?slow=switch_session:1200` 后首次请求耗时落在 1100–1400ms、第二次为 0
- [x] **T316** [US5] e2e 新增：① 新建阈值（`?slow=new_session:1200`，空态 ≤150ms + 按钮禁用）② 历史阈值（`?slow=switch_session:1200`，跳页 ≤150ms + 占位 ≤300ms + 无 `empty-state`）③ 切换失败回列表 ④ 连点两行最终落在第二行 — 验证：`npx playwright test e2e/sessions.spec.ts` 全绿，四条用例均带显式 `timeout` 数字
- [ ] **T317** 全量基线 + 文档 + 真机：`npm run typecheck` / `npx vitest run` / `npx playwright test` / `./gradlew test`；`CHANGELOG.md` 0.5.7「修复」补一条；`MANUAL_TEST.md` 增真机两条；真机记录 T1–T4 实测值 — 验证：逐条记录结果；真机实测填进 `specs/0.5.7-run-report.md`，`switch.ready` 若 >1200ms 且 `switch.tap→pending` 已 <150ms，则按 spec「拆分判断」把 C5（pi 侧耗时）单独立项

## 待真机确认

1. `new_session` / `switch_session` 在真实 pi 上的单次耗时（C5）—— 决定 T4 能否达标，也是「是否拆分」的判据之一。
2. 乐观跳页 + 内容替换两次 repaint 在 JCEF 里是否仍有旧帧残留（D4 去抖 100ms 是否够）。
3. ≤110 条消息会话的渲染耗时（`switch.content` 与 `switch.pending` 的差）—— 若单独就 >400ms，按 spec 非目标另立虚拟列表规格。
4. 会话页首次进入耗时（T313 后）：同一项目 100+ 会话、跨 14 个项目目录时的实测值。
