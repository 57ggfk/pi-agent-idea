# Feature Specification: IDE 动作路由到当前实例

**Feature Branch**: `[20261127-214745-instance-routing]`
**Created**: 2026-11-27
**Status**: 已实现（2026-11-28；T1–T5 见 [./tasks.md](./tasks.md)；T4.1–T4.3 真机点击未做，原因见 tasks）

**GitHub Issue**: [#7](https://github.com/57ggfk/pi-agent-idea/issues/7)

**Input**: 用户报缺陷——「多实例，IDE 右键菜单添加到 PI Agent，永远只添加到第一个实例。应该是当前实例才对。」

## 背景

多实例（spec 019）下，工具窗口可以有多个 Pi Content，每个绑一个 pi 进程。前端每个页面
通过 URL 的 `?instance=N` 绑定自己的实例（`web/src/bridge/jcef.ts` 的 `INSTANCE_ID`），
**每个桥接请求都带 `&instance=N`**——前端这一侧是对的。

错的是 IDE 这一侧。右键菜单动作（Explain / Fix / Send Selection / Send File /
Add Directory）都走 `BridgeService.pushIdePrompt()` / `pushIdeRefs()`，而这两个方法
调 `push(...)` **不带 instanceId**，参数默认值就是 `1`：

```kotlin
fun pushIdePrompt(text: String, refs: List<Pair<String, Boolean>> = emptyList()) {
    wirePiEvents()
    PiProcessManager.getInstance(project).client()      // ← 永远起 1 号实例
    push(buildJsonObject { ... })                       // ← instanceId 默认 1
}
```

所以无论用户当前在看哪个实例，IDE 动作的内容都落进 1 号实例的会话。

## 用户场景与验收

### User Story 1 — 右键菜单加到当前正在看的实例（Priority: P1）

**为什么重要**：多实例的意义就是并行开几个会话互不干扰。IDE 动作永远打 1 号实例，
等于多实例只对「手动在标签页里打字」有效，而最常用的「在编辑器里选中一段让 pi 看」
全都串到同一个会话——这是多实例最核心的用法被打断。

**独立可测**：开两个实例 → 在 2 号实例里右键 → 2 号的输入框收到内容，1 号不动。

**验收场景**：

1. **Given** 开着 Pi 2 且它是当前选中的 Content，**When** 在编辑器里右键「用 Pi 解释」，
   **Then** 内容进 Pi 2 的输入框，Pi 1 的输入框不动
2. **Given** 只有实例 1，**When** 右键任意动作，**Then** 行为与今天完全一致（不回归）
3. **Given** 当前选中的 Content 是浏览器标签页（不是 Pi 实例），**When** 右键动作，
   **Then** 内容进**最近使用的那个 Pi 实例**，不报错、不静默丢失
4. **Given** 一个 Pi 实例都没有（工具窗口空了），**When** 右键动作，
   **Then** 行为与今天一致（起 1 号实例并落进去）

### User Story 2 — 「当前实例」的判定规则是明确的（Priority: P1）

**验收场景**：

1. **Given** 用户在 Pi 2 里打字，然后切到 IDE 编辑器（Pi 2 仍是工具窗口里选中的 Content），
   **When** 右键动作，**Then** 仍然进 Pi 2
2. **Given** 多个 Pi 实例，选中态因为窗口重建等原因丢了，**When** 右键动作，
   **Then** 落到一个**确定的**实例（不得随机、不得报错）

## 需求（Functional Requirements）

- **FR-001**：IDE 发起的动作（prompt / refs / 粘贴的路径）必须送到**当前实例**，不是固定的 1 号。
- **FR-002**：「当前实例」必须有**确定的**判定规则，多实例并存时不得随机。
- **FR-003**：单实例场景的行为**逐字节不变**（含实例未启动时的自愈行为）。
- **FR-004**：无法判定当前实例时，行为必须可预期（退到最后一个已知实例 / 起 1 号），
  不得静默丢弃用户的内容。

## 关键设计取舍（待拍板）

- **「当前实例」怎么定**：
  - 候选 A：工具窗口 `ContentManager` 的 `selectedContent`（用户最后点开的那个 Pi 标签）
  - 候选 B：工具窗口当前**可见**的 Pi Content（浏览器标签页不算 Pi 实例）
  - 候选 C：插件自己记一个「最近交互过的实例」（前端发心跳告诉 IDE）
  - A/B 都是 IDE 侧现成事实，实现成本低；C 需要前端配合，但能覆盖「工具窗口没打开」
  的场景。
- **IDE 动作要不要顺带把对应 Content 切到前台**：今天动作只 `activate` 工具窗口，
  不切具体 Content。用户若在 Pi 2 里右键，内容落进 Pi 2 但标签没切过去 → 看不出来。
  这条要么改、要么在文档里说清。

## 非目标

- 不改单实例的默认行为。
- 不做「动作落到哪个实例由用户在菜单里选」——那是另一种交互，代价更大。

## 边界与风险

- **IDE 侧拿不到 instanceId** 是本缺陷的全部根因；改动集中在
  `BridgeService.pushIdePrompt` / `pushIdeRefs` 的调用方与签名。
- **跨端契约**：若新增 instanceId 字段，必须同一次改动里改 `web/src/bridge/types.ts`
  与 Kotlin 数据类（AGENTS.md 双端契约同步）。

## 假设与依赖

- 多实例机制本身（spec 019）工作正常，本次不碰实例的生命周期。
