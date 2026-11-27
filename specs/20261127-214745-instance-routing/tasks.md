# 任务清单：IDE 动作路由到当前实例

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214745` · **Issue**: #7

## T1 纯逻辑（先断言）

- [x] T1.1 `resolveTargetInstance(selectedId, lastPiId, liveIds)` 纯函数 + 单测
      —— 覆盖「选中 Pi」「选中浏览器」「没有 Pi 实例」三种输入 — 验证：vitest/单测红→绿
- [x] T1.2 `PiInstanceRoutingTest`：退化规则（FR-004）不静默丢内容

## T2 IDE 侧接线

- [x] T2.1 `PiAgentToolWindowFactory`：记「最近一次选中的 Pi 实例」
      （ContentManagerListener.contentSelected，浏览器标签不算）
- [x] T2.2 `BridgeService.pushIdePrompt` / `pushIdeRefs`：解析 instanceId，
      `push(..., instanceId)` + `client(instanceId)` —— 验证：单测断言推给目标实例
- [x] T2.3 `PiEditorActions` 五处动作**不改调用方式**（路由在 BridgeService 内解决）

## T3 回归

- [x] T3.1 单实例场景逐字节不变（FR-003）—— 验证：现有用例全绿
- [x] T3.2 无实例时的自愈路径不变 —— 验证：现有用例全绿

## T4 真机验收

- [ ] T4.1 两个实例 → 在 Pi 2 右键 → 内容进 Pi 2，Pi 1 不动
      —— 未做：开第二个 Pi 实例要点工具窗口标题栏的「+」，属原生 IDE UI，本环境无桌面操控工具（computer-* 不可用）。判定逻辑有 6 例单测，接线已用产物字节码核对（currentInstanceId() → selectedPiInstanceId / lastSelectedPiInstanceId / livePiInstanceIds → resolveTargetInstance，两个调用点）
- [ ] T4.2 浏览器标签页选中时右键 → 进最近用过的 Pi 实例
      —— 同上（浏览器标签页那条路径由 T1.1 的「选中的是浏览器 → 用最近选中的 Pi 实例」用例覆盖）
- [ ] T4.3 单实例右键 → 与现状一致
      —— 同上

## T5 收尾

- [x] T5.1 `changelog.d/` 碎片（正好两行，中文在前英文在后）
- [x] T5.2 `./gradlew build` 全绿 + `cd web && npm test` 全绿
- [x] T5.3 提交（时间戳照实，提交信息带 body）

## 实现记录（2026-11-28）

- **提交**：`4210643`（Kotlin 半边）；issue #7 已关闭，验收说明见 issue 评论。
- **判定规则**（`BridgeService.resolveTargetInstance`，纯函数）：选中的 Content 是 Pi 实例 → 用它；
  否则用最近一次选中的 Pi 实例；都没有 → null，调用方退回实例 1（与今天一致）。
  **已关闭的实例永远不是目标** —— 它的前端也没了，路由过去会静默丢内容。
- **接线**：`PiAgentToolWindowFactory` 的 `SelectionTracker` 只记 Pi 面板（浏览器标签不覆盖记忆值），
  状态放在 `project.getUserData`。`PiEditorActions` 五处动作**未改**。
- **测试**：`Issue7InstanceRoutingTest` 6 例（选中优先 / 浏览器标签回落 / 都没有 → null /
  已关闭实例不是目标 / 选中压过最近选中 / 退化不静默丢内容）。
- **未做**：T4.1–T4.3 的真机点击（原生 IDE UI，见上）。
