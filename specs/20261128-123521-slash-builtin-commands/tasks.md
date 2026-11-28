# 任务清单：内置斜杠命令对接（第一版）

> 分支 `feat/slash-builtin-commands`（commit 9d7c656）。

- [x] **T1** `lib/builtinCommands.ts` 三份清单（7 收录 / pi 全清单 / 不收录）+ 契约测试 6 条
- [x] **T2** store：`runBuiltinCommand` 分发表 + `pickerSignal` 状态与接口 + 分发测试 7 条（红→绿）
- [x] **T3** Composer：菜单合并（内置前置）、`applySlashCommand` 分流、键盘/点击同入口
- [x] **T4** ModelPicker / ThinkingPicker 订阅信号打开（基元订阅防对象身份陷阱）
- [x] **T5** i18n：`slash.builtin.*` 7 键 zh/en（en 为基准字典，`satisfies` 强制同步）
- [x] **T6** e2e `slash-builtin.spec.ts` 5 条 + 相邻回归 51 条全绿
- [x] **T7** changelog 碎片（`20261128-122639-slash-builtin-commands.added.md`）+ MANUAL_TEST 4 条真机清单

## 待办（非本分支）

- [x] **T9** 真机验收（2026-11-28，PyCharm 2026.3，裸 CDP 9223 驱动，工作流 dwfrun-d722559b）：
  10 项 9 过 1 挂——挂的是本 feature 自己的缺陷（`pickerSignal` 用后不清理，Composer
  切页重挂载时残留信号误弹选择器），已修复（e2f7af5，信号用后即清，回归 e2e + store
  用例双补）；另确认 `prompt`（LLM）RPC 全程 0 次、`/websearch` 真实命令 Tab 补全不变、
  `/compact` 空会话报「Nothing to compact」属观察项。证据：`out/slash-verify/`
  （results.json + shot-1~6.png）；报告与截图也发在 issue #16。
- [x] **T12** 用户真机反馈「`/clone` 不太行」→ 定位为**语义错位**：第一版把 `/clone`
  映射到插件的 `forkSession()`（RPC `fork` + 最后一个 user entryId），分叉点落在最后一条
  用户消息上，**其后的内容全部丢失**，与 pi 的 `/clone`（复制当前位置的完整会话）不符。
  修复 c04667e：新增 `store.cloneSession()` 走 RPC `clone`（pi 侧
  `runtimeHost.fork(leafId,{position:"at"})`）；`/fork` 仍不进菜单（pi 的 `/fork` 要选点
  UI，插件的每消息分叉按钮已覆盖且更好用）。
- [x] **T13** T12 复验时又发现空会话问题：pi 对**从未保存**的会话拒绝 clone/fork
  （`agent-session-runtime.js:236` "This session has not been saved yet"），英文报错
  直出。修复 1bbfcec：`cloneSession()` 在 `items.length === 0` 时前置拦截，给本地化提示
  （`error.clone.empty` zh/en）。真机复验：确认框文案「复制此会话？」、bridge 实发
  `clone`（无 `fork`）、prompt RPC 0 次、复制后会话列表出现「（分支）」副本且消息数
  与原文一致（5=5，fork 会截断）。
- [ ] **T10（P1，未立项）** 菜单 source 分组 / `argumentHint` / 空格保持菜单 / 参数补全
- [ ] **T11（P2，未立项）** 未知命令发送前兜底；排队路径模板展开（pi 上游）
