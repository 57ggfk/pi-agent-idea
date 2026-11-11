# Feature Specification: 会话列表行内动作重排 —— 复制标题+ID、clone 改名为 fork、修「点哪条都克隆最上面那条」

**Feature Branch**: `release/0.5.8`

**Created**: 2026-11-12

**Status**: Draft

**Input**: 用户反馈（2026-11-12）
> 会话列表复制按钮改成复制标题和 ID，原有的功能换成 fork 按钮，也能依赖 fork 的逻辑。
> 而且现在还有个 bug，每次无论操作哪一条复制出来的都是最上面那条。

**难度定位**：中偏小。前端一处图标/提示改名是小事，难点是**非当前会话的 fork 必须换一条数据通路**（见「问题陈述」第 2 条），
且要先用探针确认 pi 的 `--fork` CLI 语义（T001）。

## 问题陈述

### 1. 「复制」按钮名不副实，而且行为错行

`SessionsView.tsx:216-223` 的 `session-clone` 按钮画的是 `copy` 图标、`title` 是 `sessions.cloneTitle`，
实际执行 `cloneSession(s.file)`；而 `store.ts:2008` 发的是：

```ts
rpc<{ cancelled?: boolean }>(bridge, { type: "clone", sessionPath: file })
```

**`sessionPath` 对 pi 的 `clone` 是无效参数。** pi 1.5.0 的 `clone` 只做一件事：把**当前活动分支**整条复制成新会话
（007 实测记录见 `specs/007-message-fork/fork-semantics.json`，`clone` 入参只有 `{type:"clone"}`）。
于是无论点哪一行，克隆出来的都是**当前打开的那个会话**——用户看到的就是「操作哪一条都是最上面那条」。
这不是渲染错位，是**参数被静默丢弃**。

### 2. 用户想要的「fork」和 pi 的 fork 原语不是一回事

用户口径（本次确认）：列表里的 fork = **整条复制**（等价现在 clone 的意图），只是名字/图标改成 fork，
「也能依赖 fork 的逻辑」。但 pi 侧只有两种分叉能力：

| 通路 | 作用对象 | 能否用于「非当前会话」 |
|---|---|---|
| RPC `clone` | **活动会话**，忽略任何路径参数 | ❌ |
| RPC `fork {entryId}` | **活动会话**，在该用户消息前切开 | ❌ |
| CLI `pi --fork <path\|id>`（`pi --help`） | **任意会话文件**，fork 进当前目录 | ✅ 但需新起进程 |

所以「点第 7 行的 fork」在当前进程里**没有任何可用通路**。三条候选：

- **A 一次性进程（用户已选）**：新桥接方法起一个短命 `pi --fork <file>` 进程，只在磁盘上生成新会话文件后退出，
  不切走用户当前会话。代价：一次进程冷启动（≈1–2s），且要确认它不会动 `auth.json` 的锁。
- **B 先切过去再克隆**：复用现有 RPC，实现最稳，但会打断用户正在看的会话（还需切回）。
- **C 只允许当前会话 fork**：其他行按钮禁用——体验最差，仅在 A 探针失败时兜底。

**规格采用 A；A 的探针（T001）不通过则整体降级为 B**（保留「先切过去」的可回滚单步，并在确认框里说明）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 复制按钮复制标题和 ID (Priority: P1)

用户点某一行的复制按钮，剪贴板里得到两行：第一行标题，第二行会话 ID。粘贴到聊天或文档里可读，
单独要 ID 时也能直接取第二行。若该会话没有 ID（极少见的半写文件），只复制标题，并给一条可见提示，不假装成功。

**Why this priority**: 这是最直接的用户诉求，且当前行为是**错的**（拿到的是别的会话），必须先修。

**Independent Test**: 三行不同标题/ID 的 mock 会话，逐行点复制，断言 `copyText` 收到
`第 N 行标题\n第 N 行 ID`（不是第 1 行的），且三次互不相同。

### User Story 2 - clone 按钮改成 fork（整条复制）(Priority: P1)

同一位置换成 fork 图标与文案，语义是「复制整条分支」。对**当前会话**点，行为与现在的 clone 完全一致
（`clone` RPC + 列表刷新 + 标题后缀）；对**非当前会话**点，走 T001 验证过的一次性进程通路，
用户当前看到的会话、草稿、流式状态都不受影响。

**Why this priority**: 与 US1 同一处 UI，且「点哪条都对」的错行 bug 必须一起消掉，不能只改文案。

**Independent Test**: 当前会话 + 另一条历史会话各点一次 fork，断言两次生成的新会话分别来自各自的行
（mock 记录收到的目标路径/是否发生 switch），且当前会话在第二次操作后仍是原来那条。

### User Story 3 - 失败要说清楚，不静默 (Priority: P2)

fork 失败（进程起不来、超时、磁盘写失败）时给可见错误，列表不出现幽灵行；用户可重试。
非当前会话 fork 进行中，该行显示忙碌态，重复点击被吞掉（不排队、不并行起两个进程）。

**Why this priority**: 新引入一条子进程通路，失败面比纯 RPC 大；静默失败会让用户以为「fork 了但没了」。

**Independent Test**: 注入一个必定失败的 `--fork` 命令，断言出现错误条目、列表条数不变、该行忙碌态复位。

## Requirements *(mandatory)*

- **FR-001** 复制按钮 MUST 复制 `${title}\n${id}`；`title` 取 `s.name || s.preview?.slice(0,60) || s.id || "Untitled"`（与行内显示同源），
  `id` 取 `s.id`。`s.id` 缺失时只复制标题并提示「该会话没有 ID」。
- **FR-002** 复制 MUST 走既有 `lib/clipboard.ts` 的 `copyText()`，失败可见（不得出现成功态却什么都没复制）。
- **FR-003** 原 clone 位置的图标改 `fork`、`title`/`aria-label` 改「复制整条分支（Fork）」类文案，`data-testid` 由 `session-clone` 改为 `session-fork`。
- **FR-004** 「当前会话」的 fork MUST 继续走 RPC `clone`（**不再传 `sessionPath`**，因为它是无效参数），
  语义与今天的 clone 一致：新会话整条复制、标题后缀沿用 018 的 `(fork)` 规则、队列与草稿不跟随。
- **FR-005** 「非当前会话」的 fork MUST 走新桥接（暂定 `manage.sessionForkPath`），由 Kotlin 起一次性 `pi --fork <file>` 进程；
  **不得**改变当前活动会话（不得在其前后发 `switch_session`）。
- **FR-006** 一次性进程的超时 MUST 有上限（建议 30s），超时按失败处理并杀掉进程；结束后刷新会话列表。
- **FR-007** 同一时刻只允许一个列表级 fork 在跑；进行中该行忙碌、其余行按钮不禁用但会提示「另一个 fork 正在进行」。
- **FR-008** 桥接响应 MUST NOT 回传 apiKey 等凭据（复用现有脱敏口径），只回新会话文件名/标题。

## 验收口径

| 项 | 判据 |
|---|---|
| 不再错行 | 三行 mock，逐行 fork，生成的三个新会话 `sessionName` 前缀分别对应第 1/2/3 行（不允许三次都是第 1 行） |
| 复制内容 | `copyText` 实收文本 === `标题\nID`；三行互不相同 |
| 当前会话不受影响 | 对第 3 行 fork 后，`sessionId`/`items` 与操作前逐字相同 |
| 忙碌与幂等 | 连点同一行 3 次只产生 1 个新会话；失败用例列表条数不变 |
| 无凭据泄漏 | 桥接响应、DOM、日志中 `apiKey` 零出现 |

## 非目标

- 不改消息级 Fork（007/023 那套按轮末的语义），两者互不影响。
- 不做批量 fork、不做「fork 到指定目录」。
- 不重排其余动作（重命名/导出/删除）的位置与语义。

## 待确认 / 已知风险

- **`pi --fork <path>` 的副作用未实测**（T001 要回答）：是否无消息即退出、写到哪个 sessions 目录、
  是否需要 `--session-dir`、标题是否自动带 `(fork)`、是否会碰 `auth.json` 锁。任一项不成立 → 降级方案 B。
- 一次性进程冷启动 1–2s，用户点了会顿一下；先做「按钮即时变忙碌 + 行内 spinner」，不引入后台队列。
- `session-clone` 改名会打到现有 e2e（`sessions.spec.ts` 等），需同步改名而不是新增别名。
