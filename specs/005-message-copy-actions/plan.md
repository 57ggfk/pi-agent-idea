# Implementation Plan: 消息级操作（复制 / 引用 / 重新生成 / 编辑重发）

**Branch**: `005-message-copy-actions` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-message-copy-actions/spec.md`

## Summary

给消息列表加悬停操作条，提供四个消息级动作：复制（Markdown 源）、引用到输入框、
重新生成最后一条 Pi 回复、编辑并重发最后一条用户消息。

核心发现：**pi RPC 协议原生支持会话分叉**（`fork {entryId}`），重新生成与编辑重发
不需要任何截断 hack——两者统一为「fork 回最后一条 user 消息 + 重发文本」。
**Kotlin 侧零改动**：所有新命令走既有 `rpc.request` 透传通道，宪法原则 I 的双端
同步义务收窄为「web 实现与 mock 同步演进」。

## Research: pi RPC 会话分叉协议（决定性前提）

来源：本机 pi 1.4.0（`@earendil-works/pi-coding-agent`）`docs/rpc-commands.md` 与
`dist/` 源码实读，非猜测。

### 会话模型

pi 会话是**追加式树**（append-only tree of entries，带稳定 id）。模型只接收
**活动分支**，不接收整个文件。没有 truncate / 删除命令——「改历史」的正规姿势
就是 fork 出新分支。

### `fork {entryId}` 精确语义（`rpc-mode.js:481` + `agent-session-runtime.js:174`）

- `position` 默认 `"before"`：要求 entryId 是 **user 消息 entry**，否则抛
  `Invalid entry ID for forking`；
- 分支点 = 该 user 消息的 **parentId**，即新会话历史**不含**这条 user 消息；
- 响应 `{ text, cancelled }`，`text` = 被 fork 的 user 消息全文
  （`extractUserMessageText`，仅文本部分，**图片不返回**）；
- **响应中没有 sessionPath / sessionId**——运行时已在 pi 进程内切换到新的
  分支会话文件，并发 `session_start` 事件（reason: `"fork"`）；
- 可被 `session_before_fork` 扩展事件取消（返回 `cancelled: true`，本插件
  未装此类扩展，但代码必须处理该分支）。

### 配套命令

| 命令 | 用途 |
|---|---|
| `get_fork_messages` | 返回 `[{entryId, text}]`（可 fork 的 user 消息，按序）→ 用于定位最后一条 user 消息的 entryId |
| `get_messages` | fork 后调用即得新分支历史（旧回复自然消失）→ 复用 `replayMessages()` |
| `get_state` | fork 后同步 sessionId / sessionName |

### 现有代码与新协议的偏差（顺带修复项）

`store.ts` 的 `forkSession()`（SessionsView 的 Fork 按钮）预期 fork 响应含
`sessionPath`，再按 `sessionId` 兜底查找——**pi 1.4.0 两者都不返回**，该流程
在真机上已经是坏的（运行时切了会话，UI 不知道）。本特性新增的 fork 编排走
「响应 → `replayMessages` + `get_state` + `refreshSessions`」的正确路径，
并顺带把 `forkSession()` 修正到同一通路（T07）。

### 两个动作的编排

```
重新生成:  get_fork_messages → 取最后一条 user 的 entryId
         → fork {entryId} → { text }
         → replayMessages()（items 重建，旧 assistant 回复消失）
         → prompt(text)   ← 原样重发，走既有流式路径
编辑重发:  同上 fork，但 text 填回输入框进入编辑态，用户改完手动发送
```

### 限制（实现注记）

- 带图片的用户消息 fork 后只拿回文本，图片不重附——编辑重发场景下可接受
  （spec FR-009 只约束文本替换）；重新生成场景不受影响（重发的是文本）。
- fork 产生**新会话文件**，旧文件保留在磁盘（pi 的树语义，非删除）——
  SessionsView 里会出现新条目，属预期行为，不算缺陷。

## Technical Context

**Language/Version**: TypeScript + React 18 + Vite（web 侧全量）；Kotlin 侧零改动

**Primary Dependencies**: zustand store（既有）、playwright e2e（既有，mock bridge）、
vitest 单测（既有）

**Storage**: 无新增持久化（引用/编辑态均为内存 UI 状态）

**Testing**: vitest（store 纯逻辑）+ playwright e2e（行为 + 几何断言）+ 真机冒烟

**Constraints**:
- 复制在 JCEF 无异步剪贴板 API 时必须降级可用（复用 `Markdown.tsx` 的
  `copyText()` 既有实现，抽到共享 util）
- 悬停工具条不得破坏既有几何断言（宪法 II/III）

**Scale/Scope**: 新增 1 组件 + 2 store 动作 + 1 util；mock 桥补 2 命令语义；
e2e 新增约 10 条断言。**Kotlin 0 文件。**

## Constitution Check

| 原则 | 落实方式 | 结论 |
|---|---|---|
| **I. 双端契约同步** | 全部新命令（`get_fork_messages`、`fork` 新语义）走既有 `rpc.request` 透传，Kotlin 无需新增 dispatch；web `types.ts` 无新增桥接方法；**mock.ts 与实现同一批 task 内同步改**（T01 先行）；`pendingPrompt` 模式扩展是纯前端字段，不跨端 | PASS |
| **II. 断言含几何与行为** | e2e 同时断言剪贴板/输入框内容（行为）与工具条 rect 四边界在 `.app` 内、`scrollWidth === clientWidth`（几何）；单测覆盖 store 编排 | PASS |
| **III. 不依赖环境假设** | 工具条定位用实测 rect（复用 OptionsPopover 的既有模式），不按固定偏移猜；剪贴板降级显式处理 | PASS |
| **IV. 写操作可回滚** | fork 是 pi 的树分支原语，旧会话文件完整保留、可随时 switch 回去——天然可回滚；不写用户 `~/.pi` 配置 | PASS |
| **V. JCEF 单向桥** | 不新增桥接方法，不注入 JS；`rpc.request` 既有通路 | PASS |
| **VI. 凭据零托管** | 消息内容与剪贴板不涉凭据；无新增日志 | PASS |

无违反项，无需修订宪法。

## Project Structure

```text
web/src/
├── components/
│   ├── MessageList.tsx          # 改：每条消息包裹 MessageActions 触发区
│   ├── MessageActions.tsx       # 新：悬停工具条（按钮集按适用矩阵动态渲染）
│   ├── Composer.tsx             # 改：消费 quote / edit 模式的 pendingPrompt
│   └── Icon.tsx                 # 改：补 quote / refresh（若缺）
├── store/
│   ├── store.ts                 # 改：regenerate() / beginEditMessage() / quoteToComposer()
│   │                            #     pendingPrompt 加 mode: "replace" | "quote" | "edit"
│   ├── types.ts                 # 改：itemsToMarkdownSource(item) + actionsForItem(item, ctx)
│   └── types.test.ts            # 改：抽取函数 + 适用矩阵单测
├── lib/
│   └── clipboard.ts             # 新：copyText() 自 Markdown.tsx 抽出（含 JCEF 降级）
├── bridge/
│   └── mock.ts                  # 改：get_fork_messages / fork 新语义 / 重生成场景
web/e2e/
├── message-actions.spec.ts      # 新：US1–US4 行为断言（含剪贴板）
└── layout-regressions.spec.ts   # 改：工具条几何断言并入
```

## Key Decisions

1. **重新生成/编辑重发统一走 fork 原语**（见 Research），不做客户端假删除
   （只从 items 里移除但会话历史不变会导致上下文污染——明确否决）。
2. **引用/编辑预填复用 `pendingPrompt` 通路**，模式从隐式「覆盖」显式化为
   `mode: "replace" | "quote" | "edit"`：replace = 现状（IDE Explain 入口）、
   quote = 追加到草稿后不覆盖（FR-006）、edit = 覆盖并标记编辑态。
   引用格式落实 spec Assumptions 的委托：blockquote 前缀 `"> "`，
   消息文本逐行加前缀，与草稿之间以空行分隔；消息文本本身含 ``` 围栏时
   不转义（blockquote 内的围栏块在 Composer 纯文本输入里无渲染语义，
   发送后由 pi 侧解析）。
3. **`copyText()` 从 Markdown.tsx 抽到 `web/src/lib/clipboard.ts`**（新目录），
   代码块 Copy 与消息 Copy 共用，行为一致（含 JCEF 降级）。
4. **适用矩阵是唯一真源**：`actionsForItem(item, { isLast, isStreaming, busy })`
   纯函数放 store/types.ts，组件与测试共用，杜绝「按钮该不该出现」两处逻辑漂移。
5. **编辑态可视化**：Composer 顶部显示轻量「Editing · Esc 取消」徽标
   （`editingPrompt` 状态），防止用户误以为输入框内容是普通草稿；Esc 清回
   空白，满足 spec US4 场景 3 的「放弃无副作用」。
6. **流式中历史消息的操作条照常可用**：spec FR-001 只排除流式中的那条消息；
   复制/引用是读操作，流式期间不干扰；仅 regenerate/edit 因会话非空闲隐藏。
   以 `actionsForItem` 的参数表达。

## Testing Strategy（断言先行，红 → 绿）

| 层 | 对象 | 位置 |
|---|---|---|
| 单测 | `itemsToMarkdownSource`（多 text 块 / 空 / 纯图片）、适用矩阵全格 | `store/types.test.ts` |
| 单测 | store 编排：regenerate 的 fork→replay→prompt 序列（mock bridge 断言调用顺序与参数）、quote 追加不覆盖 | `store/store.test.ts`（新） |
| e2e | US1: 悬停出现工具条 → 复制 → 剪贴板内容逐字符断言 + ✓ 反馈；错误消息可复制 | `message-actions.spec.ts` |
| e2e | US2: 引用预填 + 草稿保留 + 焦点断言 | 同上 |
| e2e | US3: 重生成 → 旧回复消失、新回复流式、在途时入口禁用 | 同上 |
| e2e | US4: 编辑回填 → 改后发送 → 消息替换、旧回复移除 | 同上 |
| e2e | 几何：工具条 rect ⊆ `.app` 四边界、消息列表 `scrollWidth === clientWidth`、hover 前后消息 rect 不位移 | `layout-regressions.spec.ts` |
| 真机 | fork 重生成在真实 pi 进程下的会话切换（`session_start` 事件时序是 mock 无法覆盖的） | MANUAL_TEST 冒烟清单 |

## Risks

- **fork 响应与 pi 版本耦合**：语义已按 1.4.0 源码确认；真机冒烟兜底。
  支持区间内的旧 pi 若无 `fork`，rpc 返回 error → 按 003 号规格的错误可见性
  展示「重新生成失败：pi 版本不支持」，不静默。
- **mock 桥与真实 pi 的 `session_start` 时序差**：mock 同步返回、真实环境
  事件异步——store 编排在 fork 响应后**主动** replay，不依赖事件到达顺序。
- **悬停工具条与消息划选冲突**：工具条按钮区 `pointer-events` 独立，
  不拦截消息正文划选（用户手动划选复制与一键复制两条通路并存）。
