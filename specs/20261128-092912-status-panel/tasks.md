# 任务清单：状态面板——运行状态 / 后台任务 / 处理清单 / 待处理 / 产出

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Probe**: [probe.md](./probe.md) · **Issue**: [#15](https://github.com/57ggfk/pi-agent-idea/issues/15)

> **前端-only**：预期零 Kotlin 改动（plan 已论证五个分区的数据全部在既有事件流 / store 里）。
> 任何任务如果发现必须动 `src/`（Kotlin 桥接、进程管理），**停下来 escalate**，不顺手改桥。
>
> **断言先行**：每个实现组的第一项是对应的红测试（vitest / Playwright），先写、先跑红、再实现转绿。
> 门禁由脚本跑（`cd web && npm test` + `cd web && npx playwright test` + `npm run typecheck`），任务不勾不算完。

## T1 探针核验（先行门禁，不动代码）

- [x] T1.1 复核 [probe.md](./probe.md) §1-8 的源码引用在本机仍成立：`rpc-mode.js:106-115/128-141/579-581`（setStatus/setWidget wire 形状、Unknown command）、`async-status-projection.d.ts:3-64`（快照 DTO）、`extension-api.md:143/151/155/157/386`（index 关联、250ms、sessionFile、重建、全量替换）。不重跑探针（会烧 API 配额；结论已 3 次一致，probe.md §0）
- [x] T1.2 锁定 FR-011 数据通道 = 通道 A（`setWidget(subagent-async)` 快照），理由记入实现注释：五事件为进程内总线事件（`extension-api.md:185`），RPC 无转发路径（`rpc-mode.js:240-241`）
- [x] T1.3 把「需真实作业验证」三项（有作业快照实例 / inspect 成功变体 / `details.progress[]|results[]|runs[]` 完整字段）转入 T9 真机验收清单；确认 T4 通道 D 的 `get_messages` 回吐问题同列（plan「未线测清单」）

## T2 数据层：setStatus 条目（FR-003）

- [x] T2.1 断言（红）`web/src/store/store.statuspanel.test.ts`：`method:"setStatus"` → 条目按 statusKey upsert（同 key 覆盖不换位）；`statusText` 缺失 = 清除该 key；插入序稳定；第 13 条进表时最旧被逐出（cap 12，plan D1）；`notify` 与其它 `widgetKey` 的 setWidget 不进条目表
- [x] T2.2 断言（红）`web/src/store/types.test.ts`：`ExtensionStatus` 类型与 reducer 纯函数行为（upsert/clear/evict）与 T2.1 同源
- [x] T2.3 实现（绿）`web/src/store/store.ts` handlePiEvent 的 `extension_ui_request` 分支：setStatus 截获落 `extensionStatuses`；类型进 `web/src/store/types.ts`（双端契约真源）；现有 approvals 分支行为不回归（store.test.ts 全绿）

## T3 数据层：后台作业 reducer（FR-011 通道 A）

- [x] T3.1 断言（红）`web/src/lib/subagentSnapshot.test.ts`：`PI_SUBAGENT_ASYNC_JSON:` 前缀剥离；`kind` 非 `pi-subagents.async-status-snapshot` 或 `version!==1` → 整帧丢弃；非法 JSON → null 不抛；快照整体替换（第二帧覆盖第一帧，不合并字段）；`widgetLines` 缺省 → snapshot=null 且 seen=true
- [x] T3.2 断言（红）四态映射表（plan D2）：queued|running→运行中；paused→等待你；complete→已完成；failed|partial|stopped|rejected→失败；未知 state 原样小写展示不归组；节点 state 缺失/非字符串（wire 运行时违约）与 activity.state（`async-status-projection.d.ts:8` 本就可选）→「未知」中性徽标
- [x] T3.3 断言（红）chain 步骤流重建：`runs[].children[]` → `[{label,state}]` 序列；深度超 `caps.maxDepth` 截断并用 `omitted.children` 提示
- [x] T3.4 实现（绿）`web/src/lib/subagentSnapshot.ts`（解析 + 校验 + 映射 + 步骤流）+ `web/src/store/store.ts`：`subagentAsync{seen,snapshot,updatedAt}`；`setWidget(subagent-async)` 截获（先于 FR-003 的丢弃分支）；250ms 尾随定时器节流（in-flight 期间到达合并为下一次 flush；定时器模块级，store reset 不复活）；**会话重置（F-24 之戒）**：`resetConversationLocalState`（store.ts:947-959）与 switchSession 乐观 set（store.ts:2210-2212）**两处**都清 `subagentAsync.snapshot`（seen 保留，plan D2）
- [x] T3.5 断言（绿转验收）vitest fake timers：250ms 窗口内三帧快照只落 store 一次、且是最后一帧

## T4 数据层：transcript 重建（FR-011 通道 D）

> **2026-11-28 真机返工**：T4.1/T4.2 第一次被误判为完成——核对实现时发现
> `itemsFromMessages` 里根本没有 `details` / `subagent-notify` 解析，store 里
> 也没有 `subagentHistory`（**勾选与实现不符**）。真机（真实 IDEA 2026.2）上
> 「后台任务」分区因此长期空白：通道 A 的快照只覆盖**此刻在跑**的作业，
> 跑完的子代理没有任何来源。用户同期提出「子代理应该单独归类去展示」，
> 于是本组重做为 **FR-013 子代理分区**（见 T10），并补上**事件驱动**的
> 实时路径（不只靠重放）。

- [x] T4.1 断言（红）`subagentRunsFromMessages`：`role:"custom" && customType==="subagent-notify"` 的 `details.runs[]`（entry 形状 `agent`+`status:completed|failed|paused|stopped`，`extension-api.md:666`）；`role:"toolResult" && toolName==="subagent"` 的 `details.results[]`；workflow 的 `childRuns[]` 逐条列出；同一 runId 去重；其它工具结果/其它 customType/畸形 details 一律忽略
- [x] T4.2 实现（绿）`web/src/store/types.ts` `subagentRunsFromMessages` + `subagentRunsFromEvent`（**实时路径**：`message_end` 的 `role:"custom"` 自定义消息 / `tool_execution_end` 的 `subagent` 工具结果——pi 线上就是这么发的，`agent-session.js:823` / `:1590`）；store `subagentRuns` 落地：事件到达即合并（runId 去重），`get_messages` 三处路径（boot 重放 / switchSession / replayMessages）重建；**会话重置两处都清空**（`resetConversationLocalState` + switchSession 乐观 set）——run 属于 spawning 它的会话
- [x] T4.3 真机核验：`get_messages` 是否回吐 custom 消息与 toolResult details 仍未线测（通道 D 的**实时**路径已由真机事件流覆盖，见 T10.3；重放路径的细节形状以 pi-subagents 源码为准，`extension-api.md:666-672`）


## T5 数据层：todo 快照解析（FR-012）

- [x] T5.1 断言（红）`web/src/lib/todoSnapshot.test.ts`：`TODO_TOOL_NAMES` 白名单命中（todo_write/todowrite/todo-update/todo）；args 数组字段 `items|todos|list` 容错；条目 `text|content|label|title` × `state|status|done`（boolean→done?✓:○）归一 pending|active|done|cancelled；未 done 的 toolcall 块跳过；最近一次快照整体替换（旧快照不留残项）
- [x] T5.2 实现（绿）`web/src/lib/todoSnapshot.ts`；store 侧 `useMemo` 从 items 派生（组件挂 hook）；**注释注明**：本机未装 todo 类扩展，解析器为容错兼容层，无权威 schema，真源以真机遇到为准（plan D4）
- [x] T5.3 明确不做：pi-subagents chain 步骤态 → 处理清单的补充映射（D-推荐值，chain 流已在后台任务行内，plan D4）

## T6 数据层：产出推导（FR-006 / FR-007）

- [x] T6.1 断言（红）`web/src/lib/outputDerivation.test.ts`：`WRITE_TOOLS=["write","edit"]` 白名单；权威 argsJson 形状——write `{path,content}`、edit `{path,edits:[{oldText,newText}]}`（出处 `pi dist/core/tools/write.d.ts:4-7` / `edit.d.ts:5-11`，plan D5）路径提取；`file_path`/`filePath` 容错回退可解析（主断言仍以权威形状为准）；JSON.parse 失败跳过；bash/read 调用不算产出；按路径去重 + 改动类型集合（write=新建/重写、edit=编辑）+ 调用次数；同文件两次 edit 归一条目
- [x] T6.2 断言（红）会话隔离：换 items 数组即重算、新会话从零（纯函数性直接断言，FR-007）
- [x] T6.3 实现（绿）`web/src/lib/outputDerivation.ts`（常量注明 `dist/core/tools/index.d.ts:23` 工具全集出处）+ store 侧派生
- [x] T6.4 断言（红）store 点击行为：`showFileDiff` 现状吞错返回 void（`store.ts:2880-2886`）→ 改造返回 ok 布尔；新增 `openOutput(path)`：diff 失败/拒绝回退 `openFile`（`store.ts:2865`）；两个都不 ok 时面板条目保持可点（不静默消失）
- [x] T6.5 实现（绿）store.ts `openOutput` + showFileDiff 返回值改造（桥方法不动，`bridge/types.ts:41,43` 已有）

## T7 数据层：待处理跳转（FR-004）

- [x] T7.1 断言（红）store 单测：`goToApproval(id)` = `setTab("chat")` + 高亮队头卡（scrollIntoView 标记位）；approvals 数据本身已现成（types.ts:183-195），不加新源
- [x] T7.2 实现（绿）store.ts `goToApproval`；组件注释写明边界：ApprovalCard 只渲染 `approvals[0]`（`ApprovalCard.tsx:28`，pi 一次一问），非队头条目点击只切 tab（e2e 只对队头条目断言定位）

## T8 UI 层（弹层、互斥、i18n、mock、e2e）

- [x] T8.1 断言（红）`web/e2e/status-panel.spec.ts` 全量断言骨架（plan U6）：几何横向（360px 无横向溢出 scrollWidth<=clientWidth / 弹层 top 40px·right 8px·宽 ≤ min(320px,100cqw-24px) 换算值·右缘不出视口）**与纵向**（480×600 矮视口：弹层底缘 ≤ 视口底、超高内容弹层内滚，`.app` 纵向不裁剪 styles.css:252）；**US1 四场景（spec.md:49-53）**：空闲+模型名+上下文、流式 2s 内「生成中」、`?pistate=exited` 已退出+重启指引文案且面板内无重启按钮、setStatus 条目出现/清除；**US2（spec.md:60/64）**：「1 个待处理」计数（`?approval=1`）、类型徽标可区分（`?dialog=select|input|editor` 既有 knob）、作答后归零；互斥（开面板→开大纲面板关、开搜索面板关）+ 会话切换后面板仍开且旧作业快照已清；五分区显示/隐藏规则表；待处理点击跳转、产出点击 sessionStorage `pi-mock-show-file-diff` 回显命中路径、`?showFileDiff=fail` 回退 `ide.openFile`、切会话产出重算；i18n 切 zh。**此任务只写断言不写组件，全红**
- [x] T8.2 断言（红）store 单测：`statusPanelOpen` + `toggleStatusPanel` 三弹层互斥（开状态面板关 outline/search；开 outline/search 关状态面板）；outline↔search 既有共存行为**不变**（范围红线，plan U2）
- [x] T8.3 实现（绿）store.ts 互斥字段与 setter；会话切换**两个重置点**（`resetConversationLocalState` store.ts:947-959、switchSession 乐观 set store.ts:2210-2212）都不关状态面板（跨会话仍可看，plan U2），并在两处清旧作业快照（T3.4 已列，此处只保证面板开着不闪旧数据）
- [x] T8.4 实现（绿）`App.tsx` tab-tools 加「状态」按钮：`data-testid="status-panel-btn"`、复用 `gauge` 图标、无角标、恒显（不像 outline 按 userCount 条件隐藏）；`StatusPanel.tsx` 弹层骨架（CSS 整套复用 `.session-outline` 定位公式 `styles.css:5162-5176`：top 40px / right 8px / `min(320px, calc(100cqw - 24px))` / **`max-height:min(60vh,420px)`（styles.css:5167）+ 分区主体内部滚动（`.outline-list` `overflow-y:auto` 同款 styles.css:5202）**——`.app` 纵向不裁剪（styles.css:252），限高内滚是硬要求，z-index 55 同档）
- [x] T8.5a 断言（红）`web/src/components/StatusPanel.test.tsx`（先于实现）：运行态合成五态（running+isStreaming→生成中、running→空闲、starting→启动中、exited→已退出+重启指引文案且不渲染重启按钮、notStarted→未启动）；模型/上下文/成本三字段渲染且与 StatusBar 同源（同一 store 字段喂两组件）；setStatus 条目增删驱动渲染（upsert 显示、清除消失）；待处理计数「N 个待处理」与 method 徽标渲染；分区规则表（plan U3：后台任务 seen 才显示/处理清单无快照隐藏/待处理 0 隐藏/产出空态文案恒显）
- [x] T8.5b 实现（绿）五分区组件 + plan U3 规则表落地（按 T8.5a 断言转绿）：运行状态恒显；后台任务 seen 才显示（无作业空态文案，未 seen 整区隐藏）；处理清单无快照隐藏；待处理 0 隐藏；产出恒显 + 明确空态文案（US4-4）；模型/上下文/成本与 StatusBar 同源字段
- [x] T8.6 断言（红）panel.* 键**存在**类断言（`web/src/i18n/i18n.test.ts`）：panel.* 必需键集合（分区标题/四态徽标/空态文案等代表性键）在 en 与 zh 中都存在——**不能**写「en/zh 键集合一致」：既有 `zh covers every key of en`（i18n.test.ts:22-27）已覆盖奇偶，panel.* 两侧同缺时该断言恒绿，按字面写的测试永远红不了；实现（绿）`web/src/i18n/locales/{en,zh}.ts` 补全（FR-009）
- [x] T8.7 实现（绿）mock 场景（plan U5）：`?panel=1`——write（权威形状 `{path:"src/feature.ts",content}`）+ edit×2（权威形状，打**独立路径** `src/lib/util.ts`）+ setStatus 出现/清除 + subagent-async 三帧（空态注册/chain 2/3 运行中/complete，**帧间隔 ≥250ms（400ms）**，每帧独立落 store——否则节流吞掉运行中帧，T8.1 的「运行中→已完成」与 chain 步骤流断言永不出现）+ confirm 审批复用 `?approval=1`；产出期望按 plan U5 记账：默认 run 无条件先发的 edit（`src/main.tsx`，mock.ts:2597-2601）**算进推导**（3 路径、其一 ×2，对齐 US4-1）；`?panel=todo`（todo 快照，注明 mock-only 形状）；**mock 补桩**：`ide.showFileDiff` 补 sessionStorage 回显（`pi-mock-show-file-diff`，同 openFile 模式 mock.ts:862-870）+ `?showFileDiff=fail` knob（现状 mock.ts:882-884 裸 resolve，回退路径不可观测）；默认 mock 不带 subagent-async 帧（隐藏断言用）；**不改既有 edit 的 `old_string/new_string` mock 形状**（mock.ts:2597-2601 继续服务 ToolCard diff 测试）
- [x] T8.8 断言（绿转验收）T8.1 的 e2e 全绿（三帧间隔 ≥250ms 下「运行中→已完成」与 chain 步骤流依次可见）；250ms 节流「爆发只落最后一帧」的行为**不在 e2e 测**（真实时钟毫秒级爆发帧对用户不可见，与 T8.1 断言矛盾），由 T3.5 fake-timers 单测覆盖
- [x] T8.9 changelog 碎片 `changelog.d/20261128-status-panel.added.md`：正好两行，中文在前英文在后

## T9 真机验收（烧配额项由人定时机；不烧项常规跑）

- [x] T9.1 【烧配额】装 pi-subagents 真机触发一次后台 chain 作业：通道 A 快照实例与 .d.ts 字段对账、四态/chain 步骤流渲染、「等待你」态实拍；顺带看 inspect 成功变体（probe.md §8 未确认项闭环）
  - **已做**（2026-11-28，真实 pi 1.6.1 + pi-subagents 0.89.2，`PI_IDE_E2E=real` 起沙箱 IDE）：
    抓到 **12 个真实 `setWidget(subagent-async)` 帧**，快照字段与 probe.md §5 的
    `AsyncStatusSnapshot` DTO 逐项对上（`kind`/`version`/`caps{maxRuns,maxChildrenPerNode,
    maxDepth,maxStringLength,maxSerializedBytes}`/`omitted`/`runs[]` 带 `children[]` 步骤节点）。
    面板实测渲染出作业行：**`worker | 步骤 1/1 | 运行中 | ● worker`**——四态徽标、步骤进度、
    chain 步骤流三项同时可见。原始帧落盘 `build/verify-screenshots/real-widget-frames.json`。
  - **未闭环**：inspect 成功变体（probe.md §8 caveat 2）未取——通道 B 只在出错时有回执，
    成功变体需要 job id 且时机难控；「等待你」态未实拍（后台作业的 paused 态未在真机复现）。
    二者留作后续，不阻塞本次交付。
  - **真机走查脚本**：`scripts/probe-037-status-panel.mjs`（mock-pi 沙箱：几何/互斥/窄视口/无角标）、
    `scripts/probe-038-status-panel-real.mjs`（真实 pi：产出区、待处理、后台作业、原始帧抓取）、
    `scripts/probe-044-capture-widget-frames.mjs`（专项：抓全部 poll 载荷并搜
    `setWidget`/`subagent-async`/`PI_SUBAGENT_ASYNC_JSON`——上面 12 帧就是它抓的）。
    截图落 `build/verify-screenshots/`（不入库）。
  - **踩坑留痕**：JCEF 里 `el.click()` **不触发** React 合成事件，必须走 CDP
    `Input.dispatchMouseEvent`（页面级裸 CDP，Node 原生 WebSocket）——探针脚本按此实现。
    同理 `Page.navigate` 在 JCEF OSR 里不生效，URL 参数（mock 场景 `?panel=1`）只能在
    页面首载时生效，真机验证「后台任务」必须用真实 pi 触发真实作业。

- [ ] T9.2 【烧配额·轻】会话重载后 `get_messages` 是否回吐 custom(subagent-notify) 与 toolResult details——T4.3 降级决策点
- [ ] T9.3 【烧配额·轻】真实后台作业期间复核五事件是否出现在 stdout（预期否，plan 探针结论 2；若上线→补充通道另立任务）
- [x] T9.4 【不烧】i18n 切语言全分区文案；360px 窄面板不溢出；会话切换产出重算、新会话从零；面板与大纲/搜索互斥手感
- [x] T9.5 【不烧】全量门禁：`cd web && npm test` + `cd web && npm run typecheck` + `cd web && npx playwright test`；`./gradlew build` 确认 web/dist 同步无 Kotlin diff
- [x] T9.6 【不烧】spec.md FR-011 数据机制句回填（spec.md:127-131「订阅宿主事件…触发读 status」→ 通道 A `setWidget(subagent-async)`，引 probe.md §3/§4 作佐证）——消除 spec/plan 有意偏差的表述失配，供 `/speckit.analyze` 一致性检查通过（plan「与 spec 的偏差声明」节）

## 依赖与顺序

- T1 → 全部（通道锁定是 T3/T4 的实现前提；T1 不通过则 FR-011 降级方案在 T3/T4 内执行）
- T2/T3 可并行（不同文件不重叠）；T4/T5/T6/T7 依次或并行均可（各自模块独立）
- T8.1（e2e 红）→ T8.2-T8.7 → T8.8；T8.6 依赖 T8.5b 的键位定稿
- T9 全部依赖 T8 完成；T9.1-T9.3 烧配额，T9.4-T9.6 不烧、可分批

## 检查点

- **T1 后**：通道锁定书面确认（T1.2），实现不再讨论「要不要订阅五事件」
- **T3 后**：后台作业分区可独立用 mock 三帧联调（不依赖真机）
- **T8 后**：所有验收场景在 mock 下可复现，e2e 全绿；真机只做对账不救场

## T10 子代理分区（FR-013，2026-11-28 真机新增）

> 用户在真实 IDEA 上验收时的原话：「后台任务人家是支持的 但是你没有展示出来…
> 子代理（sub agent）应该单独归类去展示吧。」——两件事：**后台任务空白**
> （通道 D 缺失，见 T4 返工）与**子代理要单独归类**。

- [x] T10.1 分区落地：`StatusPanel.tsx` 新增「子代理」分区（`data-testid="panel-subagents"`），
      逐行 = 代理名 + 状态徽标（`panel-subagent` / `panel-subagent-badge`）；
      无记录时整区隐藏；i18n 双语（`panel.section.subagents` / `panel.subagent.unnamed`）
- [x] T10.2 状态映射：pi-subagents 的 `completed|failed|paused|stopped` → 面板徽标
      （done / failed / waiting / failed）；未知状态不臆断
- [x] T10.3 断言（绿）vitest 6 条（`subagentRunsFromMessages` 5 条 + store 会话隔离 1 条）
      + e2e 1 条（`?panel=1` 跑完后子代理分区出现 3 行、徽标正确、与后台任务分区互不混淆）
- [x] T10.4 样式：`styles.css` 加 `.panel-subagent` / `.panel-subagent-name`（与
      `.panel-job` 同款，不引入新 token）
- [x] T10.5 真机复验：在真实 IDEA 上触发一次真实后台 subagent，确认「子代理」分区
      出现对应代理名（待做——插件已重建待装）

## T11 真机（真实 IDEA 2026.2）验收留痕

- [x] T11.1 环境修复（本机既有隐患，与本 spec 无关但阻塞真机）：
      `WEBIDE_VM_OPTIONS` 指向的 `AppData\Local\JetBrains\jetbra\vmoptions\webide.vmoptions`
      **不存在**（真身在 `C:\Users\Administrator\jetbra\vmoptions\`），导致 IDEA 实际
      未加载授权 javaagent、也无 CDP 端口。已把真身文件放到环境变量指向的路径并补
      `-Dide.browser.jcef.debug.port=9222`（授权行原样保留）；IDEA 实际读取的
      `Roaming\...\idea64.exe.vmoptions` 也已补齐授权 + CDP 参数。
      **注**：2026.2 的 `ide.browser.jcef.debug.port` 是 registry 键，但 `-D` 形式
      同样生效（实测 DevTools 监听 9222）。
- [x] T11.2 走查（mock-pi 与真实 pi 两轮）发现并修复：
      **上下文行文案重复**——行标签已是「上下文」，值又用 `status.ctx`（「上下文 9%」），
      中文下渲染成「上下文 | 上下文 9% · 16,411」。已加 `panel.run.contextValue`
      纯数值键（en/zh）+ e2e 防重复断言；真机复验已生效。
- [x] T11.3 走查发现并修复：**面板无限渲染**——`usePiStore((s) => (open ? s.subagentRuns : []))`
      每次返回新数组字面量，zustand 判定状态变化 → 无限循环（页面白屏
      「Maximum update depth exceeded」）。已改用模块级 `EMPTY_RUNS` 常量。
      **教训**：zustand 选择器返回新引用必须用稳定常量。
- [ ] T11.4 未闭环：真实 pi 在 IDEA 里的 JCEF 进程崩溃过一次（面板反复
      「Rebuilding Pi Agent UI (no bridge poll for 94s)」，9222 失联）。与本次
      改动无直接证据链，但需在发版前观察。

- [x] T11.5 真机发现并修文案：subagent 写的文件（`notes/agent-check.txt`）**不出现在
      「产出」区**——产出推导只统计父会话**直接**的 write/edit 调用（FR-006 的原意
      「pi 自己的写操作」）。普通用户看到「消息里说写了文件、产出却是空的」会困惑，
      故空态文案补明边界：「本会话还没有写操作——这里列的是 pi 自己的 write/edit 调用
      （**不含子代理写的文件**），不是 git status。」en 同步。
- [x] T11.6 真机环境备注：OpenCode Zen Free 的免费额度在验收时用尽（HTTP 429
      FreeUsageLimitError）；换本机 magpie provider（127.0.0.1:3425，DeepSeek V4 Pro）
      后正常。**与本插件无关**，但说明真机验收要有备用模型。
