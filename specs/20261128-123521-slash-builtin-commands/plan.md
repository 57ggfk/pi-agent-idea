# 技术方案：内置斜杠命令对接（第一版）

## 1. 调研结论（2026-11-28，读码核实，本机 pi 1.6.1）

**已生效的三条路**（推翻「还没有实质作用」的字面理解）：插件发送裸 `{type:"prompt"}`
（`web/src/store/store.ts:1836`），pi RPC 侧 `session.prompt` 默认 `expandPromptTemplates:true`
（`agent-session.js:1709`）→ extension 命令拦截（`:1713`）→ `/skill:` 展开（`:1820`）→
prompt 模板展开。**真正的断点是内置命令**：24 条 `BUILTIN_SLASH_COMMANDS`
（`pi-coding-agent/dist/core/slash-commands.js`）不在 `get_commands`
（`rpc-mode.js:551` 只列 extension/prompt/skill）、不被拦截 → 原样进 LLM。

**pi TUI 自己的做法**（`interactive-mode.js:500+`）：菜单 = 内置 + 模板 + extension + skill
四组合并、内置前置、描述带 `[sourceTag]`、`argumentHint` 字段、/model /thinking /login 有
参数 fuzzy 补全、内置与扩展同名冲突跳过补全并出警告。第一版对齐「内置前置」。

**竞品**：Claude Code 自定义命令已并入 skills；VS Code Copilot prompt 文件带 `argument-hint`
frontmatter；JetBrains Copilot Chat **不支持**自定义斜杠命令（VS Code only，社区 #171759）、
Continue JetBrains 已转社区维护且有已知 bug（#2390）、Cursor 用 `.cursor/commands/*.md`
→ **JetBrains 上 pi 模板+skills 体系天然差异化**，值得把菜单做扎实。

## 2. 设计

### 2.1 数据：`web/src/lib/builtinCommands.ts`（三份清单一起入库）

- `BUILTIN_COMMANDS`：7 条映射 `{name, action, descKey}`；`action` 是封闭联合类型
  （`model-picker|thinking-picker|new-session|compact|clone|sessions|manage`），
  `descKey` 是字面量联合（字典索引过 tsc）。
- `PI_BUILTIN_SLASH_COMMANDS`：pi 1.6.1 完整清单，原样入库。
- `UNSUPPORTED_PI_COMMANDS`：全清单减已收录——测试断言「收录 + 不收录 = pi 全清单」，
  上游加命令时测试红，逼出显式分诊。

### 2.2 执行：`store.runBuiltinCommand(action)`

分发表，全部复用既有动作：picker 类走 `pickerSignal`（`{target, nonce}` 一次性信号，nonce
自增保证连续两次同样请求仍重触发）；`new-session`/`compact` 直调既有 action；
`clone` → `forkSession()`（024 full-copy fork，语义与 pi `/clone` 吻合）；`sessions`/`manage`
→ `setTab`（setupGate 守卫复用）。

### 2.3 UI：Composer 菜单合并

`builtinEntries`（i18n 描述、`source:"builtin"`）+ `commands`（RPC 结果）合并后过滤，
内置前置、`slice(0,8)` 不变。`applySlashCommand(entry)` 分流：内置 → `applyText("")` +
`runBuiltinCommand`；其余 → 原文本插入。键盘 Enter/Tab 与点击同一入口。

### 2.4 picker 打开：信号而非直控

ModelPicker/ThinkingPicker 的 `open` 是组件本地 state；store 订阅基元
（`target ?? null` / `nonce ?? 0`，避免对象身份比较），effect 里 `setOpen(true)`，
开后的定位/聚焦走组件既有 open 逻辑。

## 3. 测试策略（断言先行，红→绿）

- **契约**（`builtinCommands.test.ts`）：收录集合精确 7 条、name 唯一/小写、action 封闭、
  不收录集合不含已收录、三清单互恰、zh/en 描述键存在。
- **分发**（`store.slash-builtin.test.ts`，真 store + 录制 bridge）：picker 信号 nonce、
  tab 切换、`compact`/`new_session` RPC 落账、`clone` 弹确认。
- **e2e**（`slash-builtin.spec.ts`）：菜单顺序、`/model` 开选择器且输入框清空、
  `/resume` `/settings` 切 tab、部分查询过滤。
- **回归**：chat（`/sk`→Tab）、model-picker、thinking、message-fork、session-list-actions
  全量过（合计 51 条 e2e）。

## 4. 已知边界

- 拼错命令无兜底（P2）；流式中排队路径 pi 侧不展开模板（上游 `steer` 无
  `expandPromptTemplates` 通道，插件端先在 MANUAL_TEST 记录现状）。
- mock bridge 无需改动：内置命令纯前端逻辑。
