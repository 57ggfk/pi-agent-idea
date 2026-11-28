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

- [ ] **T9** 真机验收：MANUAL_TEST「Chat」节新增 4 条（内置 7 条逐一执行、拼错命令现状确认）
- [ ] **T10（P1，未立项）** 菜单 source 分组 / `argumentHint` / 空格保持菜单 / 参数补全
- [ ] **T11（P2，未立项）** 未知命令发送前兜底；排队路径模板展开（pi 上游）
