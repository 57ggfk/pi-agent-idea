# Feature Specification: 会话压缩提示文案国际化

**Feature Branch**: `release/0.5.8-20261112`

**Created**: 2026-11-12

**Status**: Approved（Q1–Q6 已全部拍板）

**Input**: 用户报告（2026-11-12）
> 会话压缩提示文案还是英文的，没有国际化

**难度定位**：文案改动本身很小，但取证过程推翻了原始假设——
「压缩提示」在代码里有**两套实现**，其中一套是**死分支**，另一套只剩手动路径。
本 spec 只记录需求与事实，不含实现。

## 问题陈述

### 现象

语言切成中文后，点输入框的「压缩」，消息流里插入英文系统通知：

```
Context compacted: 12000 → 3400 tokens.
```

### 取证一：硬编码英文共 5 处、3 类语义

| 位置 | 触发来源 | 当前文案 | 是否会被执行 |
|---|---|---|---|
| `store/types.ts:529` | 事件 `compaction_start` | `Compacting context (reason: ${reason ?? "manual"})…` | **否（死分支）** |
| `store/types.ts:541` | 事件 `compaction_end` + `aborted` | `Compaction aborted.` | **否（死分支）** |
| `store/types.ts:542` | 事件 `compaction_end` + 成功 | `Context compacted: ${before} → ${after} tokens.` | **否（死分支）** |
| `store/store.ts:1884` | 手动 `compact()` 成功 | 同上 | **是**（用户看到的这条） |
| `store/store.ts:1893` | 手动 `compact()` 失败 | `compact failed: ${message}` | **是** |

### 取证二：事件名对不上，`compaction_*` 分支永不命中 ⚠

实测 pi `18.0.7`（`@oh-my-pi/pi-coding-agent`）的 `dist/cli.js`：

| 字面量 | 出现次数 |
|---|---|
| `"compaction_start"` | **0** |
| `"compaction_end"` | **0** |
| `"auto_compaction_start"` | 7 |
| `"auto_compaction_end"` | 7 |

pi 的事件集合 `qti` 里只有 `auto_compaction_start` / `auto_compaction_end`，
转发给 RPC 时也**原样沿用该名字**
（`...else if(e.type==="auto_compaction_start")await this.#G.emit({type:"auto_compaction_start",...})`）。

而插件侧：

- `store/types.ts` 的 `applyEvent` 只列了 8 个 `case`，其中压缩只有 `compaction_start` / `compaction_end`；
- 全仓 `web/src` 搜 `auto_compaction`，除 `set_auto_compaction`（设置开关）和 `autoCompaction`（状态字段）外**无任何事件处理**。

**推论**：

1. `types.ts:527-546` 那三个 `case` 是死代码，永远不会执行——连带里面的英文文案，
   以及它想表达的「自动压缩开始/结束」提示，**当前完全不显示**。
2. 用户看到的英文，只可能来自 `store.ts:1884` 手动压缩成功提示。
3. 自动压缩（上下文将满、pi 自行触发）时消息流里**什么提示都没有**——不是英文，是静默。
   这与 `docs/PRODUCT_DESIGN.md:56`（P1-5「紧凑压缩，展示压缩前后 token 对比」）的设计意图不符。

> 结论：本条需求表面是 i18n，实际暴露出**事件名错配**。若只翻译那 5 条字符串，
> 死分支翻完仍不可见，自动压缩依然静默。范围需先明确（Q6）。

### 根因：i18n 通道本就在旁边，压缩绕过了它

- `store/store.ts:60,63` — `import { i18n } from "../i18n"; const t = i18n.t.bind(i18n);`
- 同文件 `error.*` 共 **27 个键**全部走 `t()`；连 `restartPi` 失败都用
  `t("error.restart.failed", { msg })`（`store.ts:1912`）
- `i18n/index.ts:117-121` 注释写明非组件代码可直接 `i18n.t()`，模块底部 eager init 英文兜底

压缩相关是**不同时期加入、未与 i18n 流程对齐**的遗漏，不是设计选择。

唯一技术障碍在另一半：`store/types.ts` 头注释声明
*"is a pure function so it can be unit-tested without React"*，目前仅 import `../lib/skillDisplay`。

### 术语基线

已有中文口径：`composer.compact`「压缩会话上下文」、`composer.compactLabel`「压缩」、
`options.autoCompact`「自动压缩上下文」。新文案统一用「压缩上下文」，不另起说法。

## User Scenarios & Testing

### US1 - 中文下手动压缩 (P1)

点「压缩」，消息流出现中文通知，含压缩前后 token 对比，无英文残留。

### US2 - 手动压缩失败 (P2)

`compact` RPC 抛错。显示中文「压缩失败：<原因>」，`<原因>` 保留 pi 原文不翻译。

### US3 - 自动压缩（Q6 已定 a，本轮补）(P1)

上下文将满由 pi 自动压缩。需显示中文的开始与结束提示，
`reason` 不以裸英文枚举出现在用户眼前，`action` 不展示（FR-012）。

### US4 - 压缩被中断 (P2)

压缩过程中被 abort。显示中文「压缩已中断」（该分支随 Q6 一并处置）。

### US5 - 英文用户零感知 (P1)

切回 English，手动压缩成功/失败文案**与现状逐字一致**，不得因本地化改坏英文措辞。

## Requirements

- **FR-001** 所有**可执行**路径的压缩文案 MUST 经 i18n 键产出，代码中不得残留英文字面量。
  `compaction_start` / `compaction_end` MUST 改名为 `auto_compaction_start` / `auto_compaction_end`（照 pi 18.0.7 实际事件名），
  使自动压缩提示真正可见（Q6-a）。
- **FR-002** 新增键 MUST 同时落到 `locales/zh.ts` 与 `locales/en.ts`；en 侧文本与现状逐字一致（US5）。
  两侧键集合不同即为缺陷（既有测试已校验键对齐）。
- **FR-003** 键名 MUST 遵守 spec 008 扁平 key 约定（`keySeparator: false`），形如
  `notice.compaction.start` / `.end` / `.aborted` / `.failed`。
- **FR-004** 带变量的文案 MUST 用 i18next 插值（`{{before}}` / `{{after}}` / `{{reason}}` / `{{msg}}`），
  不得字符串拼接。
- **FR-005** 取词时刻 MUST 为**消息生成时刻**（与既有 `error.*` 口径一致）；
  切换语言后已生成的历史提示不重译（Q2 已定 a）。
- **FR-006** 缺键 MUST 走 spec 008 FR-009 的 `⟦key⟧` 可见失败，不得静默回落英文。
- **FR-007** 纯 Node 单测环境（无 `import.meta.glob`、无 React）MUST 仍能产出可用文本，
  依赖 `i18n/index.ts` 的 en eager init 兜底。
- **FR-008** 若 `types.ts` 引入 i18n（Q3 已定 a），MUST 同步更新其头注释中「pure function」的表述。
- **FR-009** `reason` MUST 映射为中文（manual→手动、auto→自动），未知值原样透传（Q4 已定 b）。
- **FR-010** token 数字 MUST 千分位格式化（`12,000 → 3,400`），千分位 MUST 按当前 locale 进行，
  不得硬编码逗号（Q5 已定 b）。
- **FR-011** 同类英文通知（Q1 已定 b，见下表 6 处）MUST 一并国际化，共用同一批取词方式。
- **FR-012** `action` MUST NOT 直接展示给用户——它是 pi 的内部实现细节且取值不稳定
  （`context-full`/`snapcompact`/`handoff`/`shake`）；将来若要展示需另立映射。

### Q1 追加范围：同类英文系统通知 6 处

| 位置 | 现文案 |
|---|---|
| `store/store.ts:1684` | `Failed to send: ${message}` |
| `store/store.ts:2114` | `rename failed: ${message}` |
| `store/store.ts:2370` | `export failed: ${message}` |
| `store/store.ts:2400` | `set_model failed: ${message}` |
| `store/store.ts:2415` | `set_thinking_level failed: ${message}` |
| `store/types.ts:353` | `⚠ ${reason}: ${error}`（provider 流错误） |

## Decisions（已拍板）

| # | 问题 | 决定 |
|---|---|---|
| Q1 | 改动范围 | **b** — 压缩 + 同类 6 处，共 11 处一次收口 |
| Q2 | 切语言后历史提示是否重译 | **a** — 不重译，与现有 `error.*` 口径一致 |
| Q3 | reducer 取词路线 | **a** — `types.ts` 直接调 `i18n.t()`，同步改头注释 |
| Q4 | `reason` 显示 | **b** — 已知值映射中文，未知值原样 |
| Q5 | token 数字 | **b** — 千分位，按 locale 格式化 |
| Q6 | 自动压缩提示 | **a** — 本轮一并补，先修事件名再国际化 |

### Q6 补充事实：`action` 取值已确认，`reason` 待实测

pi 内的 method → action 映射（`cli.js`）：`obr = {remote:"context-full", snapcompact:"snapcompact",
handoff:"handoff", soft:"context-full", shake:"shake"}`，故 `action` 的取值集合为
**`context-full` / `snapcompact` / `handoff` / `shake`**；用户可选策略另有
`["remote","snapcompact","handoff","shake","soft"]` 五档。

`reason` 由调用方传入，取值未在 bundle 中固定枚举，实现时以真机抓一次事件为准。

## 不做的事

- **不动压缩触发逻辑**：何时压缩、token 预算、`set_auto_compaction` 语义一律不碰。
- **不改已有正确翻译**：`composer.compact*`、`options.autoCompact*` 已正确，不调整措辞。
- **不改造 i18n 加载机制**：懒加载 chunk、`⟦key⟧` 缺键策略沿用 spec 008。
- **不翻译 pi 返回的原始错误文本**（`{{msg}}` 原样透传）。

## 验证计划

2026-11-12 实现后填写（证据详见 `specs/0.5.8-run-report.md` 第 12 节）。

| 层 | 用例 | 期望 | 结果 |
|---|---|---|---|
| 单测 | zh 下手动 compact 成功 / 失败 | 产出中文，无英文残留 | ✅ store.test「under zh compact success and failure are Chinese」 |
| 单测 | en 下同上 | 与改动前逐字一致 | ✅ store.test 两条（成功 `Context compacted: 12,000 → 3,400 tokens.`、失败 `compact failed: boom`） |
| 单测 | zh/en 键集合对齐 | 无缺失键 | ✅ i18n.test 既有 14 条（zh covers every key of en） |
| 单测 | `reason` 映射 | manual/auto 出中文，未知值原样 | ✅ types.test en（auto/manual/handoff 透传）+ zh describe 4 条（手动/自动/snapcompact 透传） |
| 单测 | token 千分位 | `12000 → 12,000`（zh 与 en 各自格式） | ✅ types/store 断言 `12,000 → 3,400` 双语；非数字回落 `?` |
| 单测 | 自动压缩事件（Q6-a） | `auto_compaction_*` 产出开始/结束/中断提示，旧名不命中 | ✅ types.test 5 条 |
| e2e | 中文点压缩 | 消息流系统通知为中文 | ✅ compaction-i18n 3/3（zh 成功 + zh 失败 + en 逐字），全量 331/331 |
| 真机 | 中文 → 压缩 → 切英文 → 再压缩 | 各自语言正确，旧提示不重译 | ✅ 2026-11-13 `probe-031-compaction-fill.mjs` 9/9（zh 83,016 → 23,687 / en 逐字 / 不重译；证据 evidence/probe-031-compaction-fill.json） |
| 真机 | （若 Q6-a）填满上下文触发自动压缩 | 出现中文开始/结束提示，而非静默 | ◐ 部分：手动压缩的 `compaction_start` 事件通知真机出现（同一事件通道，`probe-031-compaction-fill.mjs`）；auto 真触发需 ~112k token（窗口 128k − reserve 16384）超预算，留人工。⚠️ runtime 是 @earendil-works 1.5.0，事件名 `compaction_*` 与取证包 @oh-my-pi 18.0.7 的 `auto_compaction_*` 不同——reducer 已双名兼容（run-report 第 13 节） |
