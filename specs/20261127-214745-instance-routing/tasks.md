# 任务清单：IDE 动作路由到当前实例

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214745` · **Issue**: #7

## T1 纯逻辑（先断言）

- [ ] T1.1 `resolveTargetInstance(selectedId, lastPiId, liveIds)` 纯函数 + 单测
      —— 覆盖「选中 Pi」「选中浏览器」「没有 Pi 实例」三种输入 — 验证：vitest/单测红→绿
- [ ] T1.2 `PiInstanceRoutingTest`：退化规则（FR-004）不静默丢内容

## T2 IDE 侧接线

- [ ] T2.1 `PiAgentToolWindowFactory`：记「最近一次选中的 Pi 实例」
      （ContentManagerListener.contentSelected，浏览器标签不算）
- [ ] T2.2 `BridgeService.pushIdePrompt` / `pushIdeRefs`：解析 instanceId，
      `push(..., instanceId)` + `client(instanceId)` —— 验证：单测断言推给目标实例
- [ ] T2.3 `PiEditorActions` 五处动作**不改调用方式**（路由在 BridgeService 内解决）

## T3 回归

- [ ] T3.1 单实例场景逐字节不变（FR-003）—— 验证：现有用例全绿
- [ ] T3.2 无实例时的自愈路径不变 —— 验证：现有用例全绿

## T4 真机验收

- [ ] T4.1 两个实例 → 在 Pi 2 右键 → 内容进 Pi 2，Pi 1 不动
- [ ] T4.2 浏览器标签页选中时右键 → 进最近用过的 Pi 实例
- [ ] T4.3 单实例右键 → 与现状一致

## T5 收尾

- [ ] T5.1 `changelog.d/` 碎片（正好两行，中文在前英文在后）
- [ ] T5.2 `./gradlew build` 全绿 + `cd web && npm test` 全绿
- [ ] T5.3 提交（时间戳照实，提交信息带 body）
