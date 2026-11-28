# 内置斜杠命令对接（第一版）

> 时间戳编号 · 状态：已实现（分支 `feat/slash-builtin-commands`，commit 9d7c656），待真机
> 立项来源：验收遗留「斜杠命令还没有实质作用」+ 2026-11-28 调研（竞品对照见 plan.md §1）

## 1. 问题

pi 的 24 个 TUI 内置命令（`BUILTIN_SLASH_COMMANDS`，如 `/model` `/login` `/compact`）：

- **不进** RPC `get_commands`（只返回 extension / prompt 模板 / skill 三类）；
- **不被** RPC `prompt` 拦截（`session.prompt` 的 extension 拦截查不到它们）。

于是插件里输入 `/model` 回车 = 把字面量 `/model` 当普通消息发给 LLM：浪费一轮、模型困惑作答，
且插件明明有模型选择器。`/skill:`、prompt 模板、extension 命令三条路其实**已生效**（pi 侧默认展开），
但没有 UI 反馈让人感知——菜单只是文本补全。

## 2. 用户故事与验收行为

### US1 内置命令在插件内执行

菜单前置以下 7 条（与 pi TUI 一致：内置命令排在最前）：

| 命令 | 选中回车后 |
|---|---|
| `/model` | 打开模型选择器（输入框清空） |
| `/thinking` | 打开思考档位菜单 |
| `/new` | 新建会话（有内容先弹确认，与顶栏 + New 同一条路径） |
| `/compact` | 手动压缩上下文 |
| `/clone` | 在当前位置完整复制会话（full-copy fork，弹确认） |
| `/resume` | 切到会话列表 tab |
| `/settings` | 切到管理页 tab |

**FR-1** 选中内置命令必须清空输入框、**不发出任何消息**。
**FR-2** 每条命令的执行动作与上表一致，复用既有 RPC/视图，不新增 RPC 类型。
**FR-3** 菜单描述中英双语（zh/en 同步落键，编译期强制）。

### US2 没有插件界面的命令不出菜单

**FR-4** 其余 17 条内置命令（`/export` `/fork` `/copy` `/login` `/quit` 等）**不出现**在菜单里——
菜单条目不允许「点了没反应」。不收录集合与理由入库（`lib/builtinCommands.ts`），
pi 1.6.1 完整清单一并入库：**上游新增命令时测试强制显式分诊，不许静默漏接**。
**FR-5** 拼错的命令（如 `/modle`）第一版仍按普通消息发出（P2 兜底未做，见 §4）。

### US3 既有三类命令行为不变

**FR-6** extension / prompt 模板 / `skill:` 仍是文本插入（pi 侧展开），Tab 补全行为不变。

## 3. 取舍（已拍板）

| 决策 | 选择 | 理由 |
|---|---|---|
| 对接方式 | 前端映射表 + 本地执行 | RPC 已覆盖大半（set_model/compact/fork…）；发 pi 让 extension 拦截语义不对 |
| 清单维护 | 硬编码前端 + 分诊测试 | 等 pi 上游给 RPC 加内置命令清单改动慢；测试兜住漂移 |
| `/fork` | 不收录 | pi 语义是「从历史消息选点分叉」，插件无独立选点 UI；`/clone` 已覆盖复制语义 |
| `/quit` `/hotkeys` 等 | 不收录 | 纯 TUI 命令，插件无对应物 |

## 4. 非目标（后续迭代）

- **P1**：菜单按 source 分组（对齐 pi TUI 的 `[sourceTag]`）、`argumentHint` 展示、
  空格后保持菜单进入参数态、`/model` `/thinking` `/login` 参数补全。
- **P2**：未知命令发送前兜底提示；流式中排队（steer/followUp）不展开模板（pi 上游问题，先文档标注）。

## 5. 验收

- vitest：契约测试（7 条收录 / 17 条不收录 / 覆盖 pi 清单 / 双语键）+ 分发表行为断言，13 条。
- e2e：菜单顺序、`/model` 开选择器且清空、`/resume` `/settings` 切 tab、部分查询过滤，5 条。
- 真机：MANUAL_TEST.md「Chat」节新增 4 条（含拼错命令的现状确认）。
